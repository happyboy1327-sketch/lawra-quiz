import express from 'express';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios'; 
dotenv.config();

const OC_USER_ID = process.env.LAW_GOV_OC;
const MODEL = "gemini-2.5-flash";
const client = new GoogleGenAI({ apiKey: process.env.LAW_QUIZ_GEMINI_KEY });

console.log('client의 메서드들:', Object.getOwnPropertyNames(Object.getPrototypeOf(client)));
console.log('client의 키들:', Object.keys(client));
console.log('client 타입:', typeof client);
console.log("client.responses:", client.responses);
console.log("client:", client);


const app = express();
app.use(express.json());
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Firebase Admin 초기화
let db = null;
let initializationError = null;
let serviceAccountKey = null;

try {
  serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim())
    : null;

  if (!serviceAccountKey) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY 환경 변수 없음");

  const firebaseApp = initializeApp({ credential: cert(serviceAccountKey) });
  db = getFirestore(firebaseApp);
  console.log("Firebase Admin SDK 초기화 성공");
} catch (err) {
  console.error("Firebase Admin SDK 초기화 실패:", err.message);
  db = null;
  initializationError = `Firebase Admin 초기화 실패: ${err.message}`;
}

// DB 확인 미들웨어
app.use((req, res, next) => {
  if (!db) return res.status(500).json({ error: "DB 연결 실패", message: initializationError });
  next();
});

// 랜덤 선택 가능한 법령 목록
const VALID_LAW_IDS = [
  { lawId: "001444", lawName: "대한민국헌법" },
  { lawId: "001706", lawName: "민법" },
  { lawId: "001692", lawName: "형법" },
  { lawId: "009318", lawName: "전자상거래 등에서의 소비자보호에 관한 법률" },
  { lawId: "001638", lawName: "도로교통법" },
  { lawId: "001248", lawName: "주택임대차보호법" },
  { lawId: "001206", lawName: "가사소송법" },
];

const LAW_API_BASE_URL = "https://www.law.go.kr/DRF";

// 법령 조문 랜덤 추출 함수
async function fetchLawArticles(lawId) {
  if (!OC_USER_ID) return [];
  try {
    const params = { OC: OC_USER_ID, type: 'JSON', target: 'eflaw', ID: lawId };
    const response = await axios.get(`${LAW_API_BASE_URL}/lawService.do`, { params });
    const lawData = response.data;
    const joData = lawData['법령']['조문']['조문단위'] || [];
    const articles = Array.isArray(joData) ? joData : [joData].filter(j => j);
    return articles.map(jo => ({
      num: jo['조문번호'],
      content: jo['조문내용'],
      lawName: lawData['법령']['기본정보']['법령명_한글']
    }));
  } catch (err) {
    console.error(`fetchLawArticles 오류 (ID: ${lawId}):`, err.message);
    return [];
  }
}

// 랜덤 기사 선택
async function fetchRandomArticle(law) {
  const articles = await fetchLawArticles(law.lawId);
  if (!articles || articles.length === 0) {
    console.warn('기사 없음:', law);
    return null;
  }
  const selected = articles[Math.floor(Math.random() * articles.length)];
  console.log('선택된 article:', selected);
  return selected;
}


async function generateQuiz(article) {
  console.log("generateQuiz 호출 시작, article:", article);

  try {
    if (!article || !article.lawName || !article.num) {
      console.error("유효하지 않은 article:", article);
      return null;
    }
    const contentStr = String(article.content || '');
    const cleanContent = contentStr.replace(/"/g, "'");
    
    const prompt = `
다음 한국 법령 조문을 읽고 객관식 4지선다 퀴즈 1개를 만드세요.

법령명: ${article.lawName}
조문번호: 제${article.num}조
조문내용: ${cleanContent}

위 조문의 내용을 바탕으로 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요. 난이도는 반드시 평이하게 설정.
정답 1개와 그럴듯한 오답 3개를 만드세요. 실제 퀴즈 내용을 JSON 형식으로 작성하세요.

**중요: 반드시 순수 JSON만 출력하세요. 마크다운 코드블록이나 설명 없이 JSON만 출력하세요.**

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "question": "[actual question text]",
  "options": [
    {"text": "[correct answer]", "is_correct": true},
    {"text": "[wrong answer 1]", "is_correct": false},
    {"text": "[wrong answer 2]", "is_correct": false},
    {"text": "[wrong answer 3]", "is_correct": false}
  ],
  "answer": "[same as correct answer text]",
  "explanation": "[detailed explanation]",
  "timer_sec": 15
}

위 형식으로 실제 퀴즈를 JSON으로만 출력하세요.
`;

    console.log('=== 디버깅 ===');
    console.log('API 키:', process.env.LAW_QUIZ_GEMINI_KEY ? '존재' : '없음');
    
    const response = await client.models.generateContent({
      model: MODEL,
      contents: prompt
    });
    
    let responseText = response.text;
    console.log('원본 응답:', responseText.substring(0, 300) + '...');
    
    // 마크다운 코드블록 제거
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('정제된 응답:', responseText.substring(0, 300) + '...');

    if (!responseText || responseText.trim() === '') {
      console.error("Gemini 응답이 비어 있음");
      return null;
    }

    const quiz = JSON.parse(responseText);
    console.log("퀴즈 생성 완료:", quiz.id);
    return quiz;

  } catch (e) {
    console.error("Gemini API 오류:", e.message);
    return null;
  }
}

// --- API 엔드포인트 ---
// 최신 퀴즈
app.get("/api/lawquizzes/latest", async (req, res) => {
  try {
    const snapshot = await db.collection("law_quizzes").orderBy("createdAt", "desc").limit(1).get();
    if (snapshot.empty) return res.json([]);
    const doc = snapshot.docs[0].data();
    const quizzes = doc.quizzes ? Array.isArray(doc.quizzes) ? doc.quizzes : Object.values(doc.quizzes) : [];
    res.json(quizzes);
  } catch (e) {
    console.error("latest 조회 오류:", e);
    res.status(500).json({ error: e.message });
  }
});

// 새 퀴즈 생성
app.post("/api/lawquizzes/new", async (req, res) => {
  try {
    const MAX_RETRIES = 3;
    const newQuizzes = [];

    console.log('=== 새 퀴즈 생성 시작 ===');

    for (let i = 0; i < 5; i++) {
      let quizAttempt = null;
      const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
      
      console.log(`문제 ${i + 1} 생성 시작, 법령:`, law.lawName);

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const article = await fetchRandomArticle(law);
        if (!article) {
          console.warn(`문제 ${i + 1}, 시도 ${attempt + 1}: article 없음`);
          continue;
        }

        const contentStr = String(article.content || '');
        const cleanContent = contentStr.replace(/\s+/g, ' ').trim();

        const rawQuiz = await generateQuiz({ ...article, content: cleanContent });

        console.log(`문제 ${i + 1}, 시도 ${attempt + 1}, rawQuiz:`, rawQuiz ? '성공' : '실패');

        if (!rawQuiz) {
          console.warn(`문제 ${i + 1}, 시도 ${attempt + 1} 실패, 다음 시도`);
          continue;
        }

        // ✅ ID는 Gemini가 생성한 것 사용
        quizAttempt = rawQuiz;
        console.log(`문제 ${i + 1} 생성 완료:`, quizAttempt.id);
        break;
      }

      if (quizAttempt) {
        newQuizzes.push(quizAttempt);
        console.log(`✅ 문제 ${i + 1} 추가됨`);
      } else {
        console.warn(`❌ 문제 ${i + 1} 생성 실패, 다음 문제로 넘어감`);
      }
    }

    console.log('=== 퀴즈 생성 완료 ===');
    console.log('생성된 퀴즈 개수:', newQuizzes.length);

    if (newQuizzes.length === 0) {
      return res.status(400).json({ 
        error: '퀴즈 생성 실패', 
        message: '모든 퀴즈 생성 시도가 실패했습니다.' 
      });
    }

    // ✅ 퀴즈 세트 ID 생성
    const quizSetId = `${Date.now()}`;

    // ✅ Firestore 문서 ID를 퀴즈 세트 ID로 지정
    await db.collection("law_quizzes").doc(quizSetId).set({
      createdAt: Date.now(),
      quizzes: newQuizzes
    });
    console.log('Firestore 저장 완료, 문서 ID:', quizSetId);

    res.json(newQuizzes);

  } catch (e) {
    console.error("퀴즈 생성/저장 오류:", e);
    res.status(500).json({ error: e.message });
  }
});
  
// --- 로컬 테스트용 서버 ---
//if (process.env.NODE_ENV !== "production") {
  //const PORT = process.env.PORT || 5000;
  //app.listen(PORT, () => console.log(`🚀 서버 실행 중: http://localhost:${PORT}`));//
//

app.use(express.static(path.join(__dirname, '..')));

// 👇 index.html 제공 (새로 추가)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

export default app;



