import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { getDb, rateLimitRef, chatSessionRef } from './firestore';
import type { RateLimitDocument, RateLimitWindow, RateLimitCheckResult } from '../types/rate-limit';

// -------------------------------------------------------------------------
// Rate limit configuration
// -------------------------------------------------------------------------

const LIMITS = {
  insightGenerations: { maxCount: 6, windowHours: 6 },
  chatSessions: { maxCount: 6, windowHours: 6 },
  messagesPerSession: 25,
} as const;

type RateLimitType = 'insightGenerations' | 'chatSessions';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function isWindowExpired(window: RateLimitWindow, windowHours: number): boolean {
  const expiresAt = window.windowStart.toMillis() + windowHours * 60 * 60 * 1000;
  return Date.now() >= expiresAt;
}

function freshWindow(): RateLimitWindow {
  return { count: 0, windowStart: Timestamp.now() };
}

// -------------------------------------------------------------------------
// Atomic check-and-increment via Firestore transaction
// -------------------------------------------------------------------------

/**
 * Atomically checks and increments a rate limit counter.
 * Uses a Firestore transaction to prevent race conditions.
 *
 * @throws HttpsError with 'resource-exhausted' if rate limit exceeded
 */
export async function checkAndIncrementRateLimit(
  userId: string,
  type: RateLimitType,
): Promise<RateLimitCheckResult> {
  const config = LIMITS[type];
  const ref = rateLimitRef(userId);

  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data() as RateLimitDocument | undefined;

    let window: RateLimitWindow = doc?.[type] ?? freshWindow();

    // Reset window if expired
    if (isWindowExpired(window, config.windowHours)) {
      window = freshWindow();
    }

    if (window.count >= config.maxCount) {
      const resetAt = new Date(
        window.windowStart.toMillis() + config.windowHours * 60 * 60 * 1000,
      );
      throw new HttpsError(
        'resource-exhausted',
        `Rate limit exceeded for ${type}. Try again after ${resetAt.toISOString()}.`,
      );
    }

    // Increment counter
    const updatedWindow: RateLimitWindow = {
      count: window.count + 1,
      windowStart: window.windowStart,
    };

    tx.set(ref, { [type]: updatedWindow }, { merge: true });

    return {
      allowed: true,
      remaining: config.maxCount - updatedWindow.count,
      resetAt: new Date(
        updatedWindow.windowStart.toMillis() + config.windowHours * 60 * 60 * 1000,
      ),
    };
  });
}

// -------------------------------------------------------------------------
// Message limit check (no transaction needed -- read-only check)
// -------------------------------------------------------------------------

/**
 * Checks whether a chat session has reached the per-session message limit.
 *
 * @throws HttpsError with 'resource-exhausted' if message limit reached
 */
export async function checkMessageLimit(
  userId: string,
  sessionId: string,
  currentCount: number,
): Promise<void> {
  if (currentCount >= LIMITS.messagesPerSession) {
    throw new HttpsError(
      'resource-exhausted',
      `Message limit of ${LIMITS.messagesPerSession} reached for this session. Start a new session.`,
    );
  }

  // Double-check against Firestore in case of stale count
  const sessionSnap = await chatSessionRef(userId, sessionId).get();
  const sessionData = sessionSnap.data();
  if (sessionData && sessionData.messageCount >= LIMITS.messagesPerSession) {
    throw new HttpsError(
      'resource-exhausted',
      `Message limit of ${LIMITS.messagesPerSession} reached for this session. Start a new session.`,
    );
  }
}
