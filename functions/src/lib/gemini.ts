import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { defineSecret } from 'firebase-functions/params';

const REPORT_MODEL = 'gemini-2.5-flash';
const CHAT_MODEL = 'gemini-2.5-flash';

export const geminiApiKey = defineSecret('GEMINI_API_KEY');

let genAI: GoogleGenerativeAI;

function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = geminiApiKey.value();
    if (!apiKey) throw new Error('GEMINI_API_KEY secret not set');
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

export function getReportModel(): GenerativeModel {
  return getGenAI().getGenerativeModel({
    model: REPORT_MODEL,
    generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } } as any,
  });
}

export function getChatModel(): GenerativeModel {
  return getGenAI().getGenerativeModel({
    model: CHAT_MODEL,
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } } as any,
  });
}
