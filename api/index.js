import express from 'express';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const OC_USER_ID = process.env.LAW_GOV_OC;


const app = express();
app.use(express.json());


// Firebase Admin 초기화 및 환경 변수 처리 강화 (이전과 동일)
// Firebase Admin 초기화 및 환경 변수 처리 강화
let db = null;
let initializationError = null;

// 🔽 1. 변수를 try 블록 밖(상위 스코프)에 let으로 선언 🔽
let serviceAccountKey = null; 

try {
    // 🔽 2. 선언된 변수에 값을 할당 🔽
    serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
        ? JSON.parse(
            process.env.FIREBASE_SERVICE_ACCOUNT_KEY
            .trim() // 앞뒤 공백 제거
            // 현재 어떤 형식으로 저장했는지에 따라 이 라인은 필요할 수 있습니다.
            // 마지막으로 실패한 JSON 에러를 고려하여 제거하지 않고 유지합니다.
            // .replace(/\\n/g, '\n') 
          )
        : null;

    if (!serviceAccountKey) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY 환경 변수가 설정되지 않았습니다.");
    }
    
    // 이 시점에서 serviceAccountKey는 정의되었으며, 아래 코드에서 정상적으로 사용 가능
    const firebaseApp = initializeApp({
        credential: cert(serviceAccountKey)
    });

    db = getFirestore(firebaseApp);
    console.log("Firebase Admin SDK가 성공적으로 초기화되었습니다.");

} catch (error) {
    // catch 블록에서도 serviceAccountKey를 참조하려 한다면, 이제 ReferenceError가 발생하지 않습니다.
    console.error("⚠️ Firebase Admin SDK 초기화 오류:", error.message);
    db = null;
    initializationError = `Firebase Admin 초기화 실패 give up: ${error.message}`;
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
const LAW_API_BASE_URL = "https://www.law.go.kr/DRF";
const LAW_ARTICLE_URL = `${LAW_API_BASE_URL}/lawService.do`;

/* --------------------------
    2) 법령 조문 랜덤 추출 함수
---------------------------*/
 
async function fetchLawArticles(lawId) {
  if (!OC_USER_ID) {
    console.error("❌ fetchLawArticles: LAW_QUIZ_OC_ID가 로드되지 않았습니다.");
    return [];
  }

  try {
    const params = { OC: OC_USER_ID, type: 'JSON', target: 'eflaw', 'ID': lawId };
    const response = await axios.get(LAW_API_BASE_URL, { params });
    const lawData = response.data;
    const lawInfo = lawData['법령'];
    if (!lawInfo?.조문?.조문단위) return [];

    const joData = lawInfo['조문']['조문단위'];
    const articleList = Array.isArray(joData) ? joData : [joData].filter(j => j);

    return articleList.map(jo => ({
      num: jo['조문번호'],
      content: jo['조문내용'],
      lawName: lawInfo['기본정보']['법령명_한글']
    }));
  } catch (err) {
    console.error(`🚨 fetchLawArticles 오류 (ID: ${lawId}):`, err.message);
    return [];
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
        systemInstruction: prompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            id: { type: "INTEGER" },
            category: { type: "STRING" },
            question: { type: "STRING" },
            options: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  text: { type: "STRING" },
                  is_correct: { type: "BOOLEAN" }
                 },
                 required: ["text", "is_correct"]
                }
            },
            answer: { type: "STRING" },
            explanation: { type: "STRING" },
            timer_sec: { type: "INTEGER" }
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
   // console.log(`✅ 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);//
//
