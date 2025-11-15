import express from 'express';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();
// import { shuffle } from 'lodash'; <--- ❌ lodash 제거

const app = express();
app.use(express.json());


// Firebase Admin 초기화 및 환경 변수 처리 강화 (이전과 동일)
let db = null;
let initializationError = null;

try {
    const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'))
        : null;

    if (!serviceAccountKey) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY 환경 변수가 설정되지 않았습니다.");
    }

    const firebaseApp = initializeApp({
        credential: cert(serviceAccountKey)
    });

    db = getFirestore(firebaseApp);
    console.log("Firebase Admin SDK가 성공적으로 초기화되었습니다.");

} catch (error) {
    console.error("⚠️ Firebase Admin SDK 초기화 오류:", error.message);
    db = null;
    initializationError = `Firebase Admin 초기화 실패: ${error.message}`;
}


// --- 미들웨어: DB 유효성 검사 (이전과 동일) ---
const checkDbConnection = (req, res, next) => {
    if (!db) {
        return res.status(500).json({
            error: "서버 설정 오류",
            message: initializationError || "데이터베이스 연결에 실패했습니다. 서버 로그를 확인하십시오."
        });
    }
    next();
};

app.use(checkDbConnection);
/* --------------------------
    1) 랜덤 선택 가능한 법령 목록
---------------------------*/
const VALID_LAW_IDS = [
  { lawId: "001444", lawName: "대한민국헌법" },
  { lawId: "001706", lawName: "민법" },
  { lawId: "001692", lawName: "형법" },
  { lawId: "009318", lawName: "전자상거래 등에서의 소비자보호에 관한 법률" },
  { lawId: "001638", lawName: "도로교통법" },
  { lawId: "001248", lawName: "주택임대차보호법" },
  { lawId: "001206", lawName: "가사소송법" },
];

/* --------------------------
    2) 법령 조문 랜덤 추출 함수
---------------------------*/
async function fetchRandomArticle(law) {
  try {
    // Node.js 기본 fetch 사용
    const url = `https://www.law.go.kr/DRF/lawService.do?OC=${process.env.LAW_GOV_OC}&target=law&ID=${law.lawId}&type=json`;
    const res = await fetch(url);
    
    // HTTP 오류 처리
    if (!res.ok) {
        console.error(`Law.go.kr API 오류: ${res.status} ${res.statusText}`);
        return null;
    }

    const json = await res.json();
    
    // 데이터 구조가 비어있거나 예상과 다를 경우 처리
    const articles = json.JEYO_LIST || json.JEYO;
    if (!articles) return null;

    const arr = Array.isArray(articles) ? articles : [articles];

    // 배열이 비어있는 경우 체크
    if (arr.length === 0) return null;

    const pick = arr[Math.floor(Math.random() * arr.length)];

    return {
      lawId: law.lawId,
      lawName: law.lawName,
      num: pick.ArticleNo,
      // Paragraph가 배열일 수도 있으므로, 안전하게 처리
      content: Array.isArray(pick.Paragraph) ? JSON.stringify(pick.Paragraph) : pick.Paragraph ? pick.Paragraph : ""
    };
  } catch (e) {
    console.error("조문 fetch 오류:", e);
    return null;
  }
}

/* --------------------------
    3) 공식 Gemini SDK 기반 퀴즈 생성기
---------------------------*/
const MODEL = "gemini-2.5-flash";
const client = new GoogleGenAI({ apiKey: process.env.LAW_QUIZ_GEMINI_KEY });

async function generateQuiz(article) {
  const prompt = `
당신은 한국 법률 조문 기반 객관식 4지선다 퀴즈 생성기.
아래 JSON 스키마로만 출력:

{
  "id": "string or number",
  "category": "string",
  "question": "string",
  "options": [
    {"text": "string", "is_correct": true/false},
    {"text": "string", "is_correct": true/false},
    {"text": "string", "is_correct": true/false},
    {"text": "string", "is_correct": true/false}
  ],
  "answer": "정답 보기 text 그대로",
  "explanation": "string",
  "timer_sec": 15
}

법령명: ${article.lawName}
조문번호: ${article.num}
조문내용: ${article.content}
중요: JSON 외 아무 텍스트도 출력 금지.
`;

  try {
    // Structured Output (JSON Schema)을 사용하여 안정적인 JSON 응답을 유도합니다.
    const resp = await client.responses.create({
      model: MODEL,
      input: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            id: { type: "NUMBER" },
            category: { type: "STRING" },
            question: { type: "STRING" },
            options: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  text: { type: "STRING" },
                  is_correct: { type: "BOOLEAN" }
                }
              }
            },
            answer: { type: "STRING" },
            explanation: { type: "STRING" },
            timer_sec: { type: "NUMBER" }
          },
          required: ["id", "category", "question", "options", "answer", "explanation", "timer_sec"]
        }
      }
    });

    const rawJsonText = resp.output_text.trim();
    return JSON.parse(rawJsonText);
  } catch (e) {
    console.error("Gemini API 오류:", e);
    // JSON 파싱 실패를 더 명확히 기록
    if (e.message.includes("JSON")) console.error("Gemini 응답이 유효한 JSON이 아님:", e.message);
    return null;
  }
}

/* --------------------------
    4) API 라우팅
---------------------------*/

// 마지막 퀴즈 세트 가져오기
app.get("/api/lawquizzes/latest", async(req,res)=>{
  try{
    // Firestore 경로는 /artifacts/{appId}/public/data/law_quizzes/{docId}가 되어야 합니다.
    // 하지만 현재 제공된 firebase-admin.js는 이를 고려하지 않으므로, 
    // 임시로 기본 경로인 'law_quizzes'를 사용합니다.
    const snapshot = await db.collection("law_quizzes").orderBy("createdAt","desc").limit(1).get();
    if(snapshot.empty){ return res.json([]); }
    const doc = snapshot.docs[0].data();
    const quizzes = doc.quizzes ? Object.values(doc.quizzes) : Array.isArray(doc.quizzes) ? doc.quizzes : [];
    res.json(quizzes);
  }catch(e){ 
    console.error("Firestore 'latest' 조회 오류:", e); 
    res.status(500).json({error:e.message}); 
  }
});

// 새 퀴즈세트 생성
app.post("/api/lawquizzes/new", async (req, res) => {
  try {
    const newQuizzes = [];

    // 5문제 랜덤 생성
    for (let i = 0; i < 5; i++) {
      const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
      
      // 퀴즈 생성이 실패하면 재시도 로직을 추가하여 안정성 향상
      let quizAttempt = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const article = await fetchRandomArticle(law);
        if (!article) continue;
        
        const rawQuiz = await generateQuiz(article);
        if (rawQuiz) {
          quizAttempt = {
            ...rawQuiz,
            // id 생성 시 충돌 가능성 줄이기 위해 고유값 사용
            id: `${Date.now()}-${i}-${Math.floor(Math.random() * 1000)}`,
            article
          };
          break;
        }
      }

      if (quizAttempt) {
        newQuizzes.push(quizAttempt);
      }
    }

    if (newQuizzes.length === 0)
      return res.status(503).json({ error: "퀴즈 생성 서비스 일시적 실패 (API 응답 없음)" });

    // Firestore 저장
    // 퀴즈 배열을 직접 저장하도록 수정 (객체 형태가 아닌 배열)
    await db.collection("law_quizzes").add({
      createdAt: Date.now(),
      quizzes: newQuizzes
    });

    res.json(newQuizzes);
  } catch (e) {
    console.error("퀴즈 생성/저장 오류:", e);
    res.status(500).json({ error: e.message });
  }
});

// 🌟 Vercel 배포를 위해 Express 앱을 모듈로 내보냅니다.
export default app;

//const PORT = 5000; // 사용할 포트 번호




// 3. 미들웨어 설정 (필요한 경우)


// 미들웨어 및 라우팅 설정...
// app.get('/', (req, res) => { res.send('Hello World'); });

// 서버를 시작하고 특정 포트에서 요청을 수신합니다.
//app.listen(PORT, () => {
    // 서버가 성공적으로 시작되면 콘솔에 메시지를 출력합니다.
   // console.log(`✅ 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);




