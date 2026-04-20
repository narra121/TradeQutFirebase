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
// Check-only (no increment) via Firestore transaction
// -------------------------------------------------------------------------

/**
 * Checks whether the rate limit has been exceeded WITHOUT incrementing.
 * Useful when you want to verify quota before starting expensive work,
 * then increment only after success.
 *
 * @throws HttpsError with 'resource-exhausted' if rate limit exceeded
 */
export async function checkRateLimit(
  userId: string,
  type: RateLimitType,
): Promise<RateLimitCheckResult> {
  const config = LIMITS[type];
  const ref = rateLimitRef(userId);

  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data() as RateLimitDocument | undefined;

    let window: RateLimitWindow = doc?.[type] ?? freshWindow();

    // Reset window if expired (write fresh window so next check sees clean state)
    if (isWindowExpired(window, config.windowHours)) {
      window = freshWindow();
      tx.set(ref, { [type]: window }, { merge: true });
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

    return {
      allowed: true,
      remaining: config.maxCount - window.count,
      resetAt: new Date(
        window.windowStart.toMillis() + config.windowHours * 60 * 60 * 1000,
      ),
    };
  });
}

// -------------------------------------------------------------------------
// Increment-only (no limit check) via Firestore transaction
// -------------------------------------------------------------------------

/**
 * Increments the rate limit counter by 1. Resets the window if expired.
 * Does NOT check the limit — assumes the caller already verified via checkRateLimit.
 */
export async function incrementRateLimit(
  userId: string,
  type: RateLimitType,
): Promise<void> {
  const config = LIMITS[type];
  const ref = rateLimitRef(userId);

  await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data() as RateLimitDocument | undefined;

    let window: RateLimitWindow = doc?.[type] ?? freshWindow();

    // Reset window if expired
    if (isWindowExpired(window, config.windowHours)) {
      window = freshWindow();
    }

    const updatedWindow: RateLimitWindow = {
      count: window.count + 1,
      windowStart: window.windowStart,
    };

    tx.set(ref, { [type]: updatedWindow }, { merge: true });
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
