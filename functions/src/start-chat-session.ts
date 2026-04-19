import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { getDb } from './lib/firestore';
import { checkAndIncrementRateLimit } from './lib/rate-limit';
import type { TrimmedTrade, ChatSessionDocument } from './types/insight';

/** Max trades stored in session doc (~500 bytes per trimmed trade, Firestore 1MB doc limit) */
const MAX_SESSION_TRADES = 1000;

/** Session expiry: 24 hours from creation */
const SESSION_TTL_HOURS = 24;

interface StartChatInput {
  trades: TrimmedTrade[];
  accountId: string;
  period: string;
  tradesHash: string;
}

function validateInput(data: unknown): StartChatInput {
  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.trades) || d.trades.length === 0) {
    throw new HttpsError('invalid-argument', 'trades must be a non-empty array');
  }
  if (typeof d.accountId !== 'string' || d.accountId.length === 0) {
    throw new HttpsError('invalid-argument', 'accountId is required');
  }
  if (typeof d.period !== 'string' || d.period.length === 0) {
    throw new HttpsError('invalid-argument', 'period is required');
  }
  if (typeof d.tradesHash !== 'string' || d.tradesHash.length === 0) {
    throw new HttpsError('invalid-argument', 'tradesHash is required');
  }

  return {
    trades: d.trades as TrimmedTrade[],
    accountId: d.accountId as string,
    period: d.period as string,
    tradesHash: d.tradesHash as string,
  };
}

export const startChatSession = onCall(
  {
    enforceAppCheck: false,
    memory: '256MiB',
    timeoutSeconds: 30,
    region: 'us-central1',
  },
  async (request) => {
    // 1. Auth check
    const userId = request.auth?.uid;
    if (!userId) {
      throw new HttpsError('unauthenticated', 'Authentication required');
    }

    // 2. Input validation
    const { trades, accountId, period, tradesHash } = validateInput(request.data);

    // 3. Rate limit check
    await checkAndIncrementRateLimit(userId, 'chatSessions');

    // 4. Truncate trades to fit within Firestore 1MB doc limit
    const truncatedTrades = trades.slice(0, MAX_SESSION_TRADES);

    // 5. Create session document
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(
      now.toMillis() + SESSION_TTL_HOURS * 60 * 60 * 1000,
    );

    const sessionDoc: ChatSessionDocument = {
      accountId,
      period,
      trades: truncatedTrades,
      tradesHash,
      messageCount: 0,
      createdAt: now,
      expiresAt,
      status: 'active',
    };

    const db = getDb();
    const sessionRef = db.collection(`users/${userId}/chatSessions`).doc();
    await sessionRef.set(sessionDoc);

    logger.info('Chat session created', {
      userId,
      sessionId: sessionRef.id,
      tradeCount: truncatedTrades.length,
      accountId,
      period,
    });

    return { sessionId: sessionRef.id };
  },
);
