import { getFirestore } from 'firebase-admin/firestore';

let db: FirebaseFirestore.Firestore;

export function getDb(): FirebaseFirestore.Firestore {
  if (!db) db = getFirestore();
  return db;
}

export function insightRef(userId: string, insightId: string) {
  return getDb().doc(`users/${userId}/insights/${insightId}`);
}

export function chatSessionRef(userId: string, sessionId: string) {
  return getDb().doc(`users/${userId}/chatSessions/${sessionId}`);
}

export function chatMessagesCol(userId: string, sessionId: string) {
  return getDb().collection(`users/${userId}/chatSessions/${sessionId}/messages`);
}

export function rateLimitRef(userId: string) {
  return getDb().doc(`users/${userId}/rateLimits/current`);
}
