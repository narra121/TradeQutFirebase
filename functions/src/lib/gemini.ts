import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

const REPORT_MODEL = 'gemini-2.5-flash';
const CHAT_MODEL = 'gemini-2.5-flash';

let genAI: GoogleGenerativeAI;

function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY env var not set');
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

export function getReportModel(): GenerativeModel {
  return getGenAI().getGenerativeModel({ model: REPORT_MODEL });
}

export function getChatModel(): GenerativeModel {
  return getGenAI().getGenerativeModel({
    model: CHAT_MODEL,
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
  });
}
