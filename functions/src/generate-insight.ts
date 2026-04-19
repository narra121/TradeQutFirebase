import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { insightRef } from './lib/firestore';
import { checkAndIncrementRateLimit } from './lib/rate-limit';
import { getReportModel, geminiApiKey } from './lib/gemini';
import { REPORT_SYSTEM_PROMPT, tryParsePartialInsights } from './lib/prompts';
import type { TrimmedTrade, InsightDocument, InsightsResponse } from './types/insight';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const MAX_TRADES = 2000;

/** Top-level fields we progressively write to Firestore as they become parseable */
const PROGRESSIVE_FIELDS = ['summary', 'profile', 'scores', 'insights', 'tradeSpotlights', 'patterns'] as const;

// -------------------------------------------------------------------------
// Input validation
// -------------------------------------------------------------------------

interface GenerateInsightInput {
  trades: TrimmedTrade[];
  accountId: string;
  period: string;
  tradesHash: string;
}

function validateInput(data: unknown): GenerateInsightInput {
  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.trades) || d.trades.length === 0) {
    throw new HttpsError('invalid-argument', 'trades must be a non-empty array');
  }
  if (d.trades.length > MAX_TRADES) {
    throw new HttpsError('invalid-argument', `trades array exceeds maximum of ${MAX_TRADES}`);
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

  // Validate individual trade shape (spot-check first trade)
  const firstTrade = d.trades[0] as Record<string, unknown>;
  if (typeof firstTrade.tradeId !== 'string' || typeof firstTrade.pnl !== 'number') {
    throw new HttpsError('invalid-argument', 'Each trade must have at least tradeId (string) and pnl (number)');
  }

  return {
    trades: d.trades as TrimmedTrade[],
    accountId: d.accountId as string,
    period: d.period as string,
    tradesHash: d.tradesHash as string,
  };
}

// -------------------------------------------------------------------------
// Cloud Function
// -------------------------------------------------------------------------

export const generateInsight = onCall(
  {
    enforceAppCheck: true,
    memory: '512MiB',
    timeoutSeconds: 120,
    region: 'us-central1',
    secrets: [geminiApiKey],
  },
  async (request) => {
    // 1. Auth check
    const userId = request.auth?.uid;
    if (!userId) {
      throw new HttpsError('unauthenticated', 'Authentication required');
    }

    // 2. Input validation
    const { trades, accountId, period, tradesHash } = validateInput(request.data);

    // Build a deterministic insight ID from accountId + period
    const insightId = `${accountId}_${period}`;
    const ref = insightRef(userId, insightId);

    // 3. Cache check: if insight doc exists with same tradesHash + status 'complete', return cached
    const existingSnap = await ref.get();
    if (existingSnap.exists) {
      const existing = existingSnap.data() as InsightDocument;
      if (existing.tradesHash === tradesHash && existing.status === 'complete') {
        logger.info('Returning cached insight', { userId, insightId });
        return { cached: true, insightId };
      }
    }

    // 4. Rate limit check
    await checkAndIncrementRateLimit(userId, 'insightGenerations');

    // 5. Write initial generating doc
    const initialDoc: InsightDocument = {
      status: 'generating',
      tradesHash,
      accountId,
      period,
      generatedAt: Timestamp.now(),
    };
    await ref.set(initialDoc);

    // 6. Stream from Gemini and progressively update Firestore
    try {
      const model = getReportModel();
      const prompt = REPORT_SYSTEM_PROMPT + JSON.stringify(trades);

      const result = await model.generateContentStream(prompt);

      let accumulated = '';
      const writtenFields = new Set<string>();

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (!text) continue;
        accumulated += text;

        // Try progressive parsing
        const partial = tryParsePartialInsights(accumulated);
        if (!partial) continue;

        // Write newly-available top-level fields to Firestore
        const updates: Record<string, unknown> = {};
        for (const field of PROGRESSIVE_FIELDS) {
          if (partial[field as keyof InsightsResponse] !== undefined && !writtenFields.has(field)) {
            updates[field] = partial[field as keyof InsightsResponse];
            writtenFields.add(field);
          }
        }

        if (Object.keys(updates).length > 0) {
          await ref.update(updates);
          logger.info('Progressive update', { userId, insightId, fields: Object.keys(updates) });
        }
      }

      // 7. Final parse and write
      let finalData: Partial<InsightsResponse>;
      try {
        finalData = JSON.parse(accumulated) as InsightsResponse;
      } catch {
        // Fall back to partial parse if final parse fails
        const partial = tryParsePartialInsights(accumulated);
        if (!partial || !partial.summary) {
          throw new Error('Failed to parse Gemini response as valid InsightsResponse');
        }
        finalData = partial;
      }

      // 8. Final write: status 'complete' + all parsed fields
      const finalUpdate: Record<string, unknown> = { status: 'complete' };
      for (const field of PROGRESSIVE_FIELDS) {
        const value = finalData[field as keyof InsightsResponse];
        if (value !== undefined) {
          finalUpdate[field] = value;
        }
      }
      await ref.update(finalUpdate);

      logger.info('Insight generation complete', { userId, insightId });
      return { cached: false, insightId };
    } catch (error) {
      // 9. On error: write status 'error' to Firestore
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during generation';
      logger.error('Insight generation failed', { userId, insightId, error: errorMessage });

      await ref.update({
        status: 'error',
        error: errorMessage,
      });

      throw new HttpsError('internal', 'Insight generation failed. Please try again.');
    }
  },
);
