import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockTimestamp, hoursAgo, nowMs, createMockDocSnapshot } from '../helpers';

// ---------------------------------------------------------------------------
// Firestore mock
// ---------------------------------------------------------------------------

const mockTxGet = vi.fn();
const mockTxSet = vi.fn();
const mockRunTransaction = vi.fn();

const mockDocRef = { id: 'current' };

const mockDb = {
  doc: vi.fn().mockReturnValue(mockDocRef),
  runTransaction: mockRunTransaction,
};

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => mockDb),
  Timestamp: {
    now: () => mockTimestamp(Date.now()),
    fromMillis: (ms: number) => mockTimestamp(ms),
    fromDate: (d: Date) => mockTimestamp(d.getTime()),
  },
}));

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(),
}));

vi.mock('firebase-functions/v2/https', () => ({
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'HttpsError';
    }
  },
  onCall: vi.fn(),
}));

// Mock the firestore lib module
vi.mock('../../src/lib/firestore', () => ({
  getDb: () => mockDb,
  rateLimitRef: () => mockDocRef,
  chatSessionRef: () => mockDocRef,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { checkAndIncrementRateLimit, checkMessageLimit } from '../../src/lib/rate-limit';

beforeEach(() => {
  vi.clearAllMocks();

  // Default: transaction calls the fn with mock tx
  mockRunTransaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => {
    const tx = { get: mockTxGet, set: mockTxSet };
    return fn(tx);
  });
});

describe('rate-limit', () => {
  describe('checkAndIncrementRateLimit', () => {
    it('allows first request when no rate limit doc exists and creates a new window', async () => {
      mockTxGet.mockResolvedValue(createMockDocSnapshot(null));

      const result = await checkAndIncrementRateLimit('user-1', 'insightGenerations');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5); // 6 max - 1 used
      expect(mockTxSet).toHaveBeenCalledTimes(1);
    });

    it('allows request within window and under limit', async () => {
      mockTxGet.mockResolvedValue(
        createMockDocSnapshot({
          insightGenerations: {
            count: 3,
            windowStart: mockTimestamp(nowMs()),
          },
        }),
      );

      const result = await checkAndIncrementRateLimit('user-1', 'insightGenerations');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2); // 6 - (3+1) = 2
    });

    it('throws resource-exhausted when at the limit within active window', async () => {
      mockTxGet.mockResolvedValue(
        createMockDocSnapshot({
          insightGenerations: {
            count: 6,
            windowStart: mockTimestamp(nowMs()),
          },
        }),
      );

      await expect(
        checkAndIncrementRateLimit('user-1', 'insightGenerations'),
      ).rejects.toThrow(/resource-exhausted|Rate limit exceeded/i);
    });

    it('resets the window and allows when previous window has expired', async () => {
      mockTxGet.mockResolvedValue(
        createMockDocSnapshot({
          insightGenerations: {
            count: 6,
            windowStart: mockTimestamp(hoursAgo(7)), // 7 hours > 6hr window
          },
        }),
      );

      const result = await checkAndIncrementRateLimit('user-1', 'insightGenerations');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5); // fresh window: 6 - 1
    });

    it('returns correct remaining count after increment', async () => {
      mockTxGet.mockResolvedValue(
        createMockDocSnapshot({
          insightGenerations: {
            count: 4,
            windowStart: mockTimestamp(nowMs()),
          },
        }),
      );

      const result = await checkAndIncrementRateLimit('user-1', 'insightGenerations');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1); // 6 - (4+1) = 1
    });

    it('includes resetAt date in the result', async () => {
      const windowStartMs = nowMs();
      mockTxGet.mockResolvedValue(
        createMockDocSnapshot({
          insightGenerations: {
            count: 2,
            windowStart: mockTimestamp(windowStartMs),
          },
        }),
      );

      const result = await checkAndIncrementRateLimit('user-1', 'insightGenerations');

      expect(result.resetAt).toBeInstanceOf(Date);
      const expectedResetMs = windowStartMs + 6 * 60 * 60 * 1000;
      expect(result.resetAt!.getTime()).toBeCloseTo(expectedResetMs, -2);
    });

    it('handles chatSessions rate limit type', async () => {
      mockTxGet.mockResolvedValue(createMockDocSnapshot(null));

      const result = await checkAndIncrementRateLimit('user-1', 'chatSessions');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5);
    });

    it('uses a Firestore transaction for atomicity', async () => {
      mockTxGet.mockResolvedValue(createMockDocSnapshot(null));

      await checkAndIncrementRateLimit('user-1', 'insightGenerations');

      expect(mockRunTransaction).toHaveBeenCalledTimes(1);
      expect(mockRunTransaction).toHaveBeenCalledWith(expect.any(Function));
    });

    it('merges the rate limit field using { merge: true }', async () => {
      mockTxGet.mockResolvedValue(
        createMockDocSnapshot({
          chatSessions: {
            count: 2,
            windowStart: mockTimestamp(nowMs()),
          },
          // No insightGenerations field yet
        }),
      );

      await checkAndIncrementRateLimit('user-1', 'insightGenerations');

      expect(mockTxSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ insightGenerations: expect.any(Object) }),
        expect.objectContaining({ merge: true }),
      );
    });

    it('at count=5 allows one more request (total 6, which is the max)', async () => {
      mockTxGet.mockResolvedValue(
        createMockDocSnapshot({
          insightGenerations: {
            count: 5,
            windowStart: mockTimestamp(nowMs()),
          },
        }),
      );

      const result = await checkAndIncrementRateLimit('user-1', 'insightGenerations');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0); // 6 - (5+1) = 0
    });
  });

  describe('checkMessageLimit', () => {
    it('passes silently when message count is under 25', async () => {
      // chatSessionRef returns mockDocRef, which has a `get` that we can mock
      // The real module calls chatSessionRef(userId, sessionId).get()
      // Our mock already returns mockDocRef, so we just need mockDocRef to have get()
      const mockSessionGet = vi.fn().mockResolvedValue(
        createMockDocSnapshot({ messageCount: 10 }),
      );
      // Add get to mockDocRef temporarily
      (mockDocRef as any).get = mockSessionGet;

      await expect(
        checkMessageLimit('user-1', 'session-1', 10),
      ).resolves.toBeUndefined();
    });

    it('throws resource-exhausted when currentCount is 25 or more', async () => {
      await expect(
        checkMessageLimit('user-1', 'session-1', 25),
      ).rejects.toThrow(/resource-exhausted|Message limit/i);
    });
  });
});
