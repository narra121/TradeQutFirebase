import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockRequest,
  createUnauthenticatedRequest,
  createMockTrades,
} from './helpers';

// ---------------------------------------------------------------------------
// Firestore mock
// ---------------------------------------------------------------------------

const mockDocSet = vi.fn().mockResolvedValue(undefined);
const mockAutoDocRef = { set: mockDocSet, id: 'auto-session-id-123' };
const mockCollectionDoc = vi.fn().mockReturnValue(mockAutoDocRef);
const mockCollectionRef = { doc: mockCollectionDoc };
const mockDb = {
  doc: vi.fn(),
  collection: vi.fn().mockReturnValue(mockCollectionRef),
  runTransaction: vi.fn(),
};

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => mockDb),
  Timestamp: {
    now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }),
    fromMillis: (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
  },
  FieldValue: {
    serverTimestamp: () => 'SERVER_TIMESTAMP',
    increment: (n: number) => ({ _increment: n }),
  },
}));

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Firebase Functions mock
// ---------------------------------------------------------------------------

vi.mock('firebase-functions/v2/https', () => ({
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'HttpsError';
    }
  },
  onCall: (_opts: unknown, handler: Function) => handler,
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock lib/firestore — getDb returns our mockDb
// ---------------------------------------------------------------------------

vi.mock('../src/lib/firestore', () => ({
  getDb: () => mockDb,
}));

// ---------------------------------------------------------------------------
// Mock lib/rate-limit
// ---------------------------------------------------------------------------

const mockCheckAndIncrementRateLimit = vi.fn();

vi.mock('../src/lib/rate-limit', () => ({
  checkAndIncrementRateLimit: (...args: unknown[]) => mockCheckAndIncrementRateLimit(...args),
}));

// ---------------------------------------------------------------------------
// Import (triggers onCall registration)
// ---------------------------------------------------------------------------

import { startChatSession } from '../src/start-chat-session';

beforeEach(() => {
  vi.clearAllMocks();

  mockCheckAndIncrementRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 5,
    resetAt: new Date(),
  });

  // Ensure doc() returns the mock auto-generated ref
  mockCollectionDoc.mockReturnValue(mockAutoDocRef);
});

describe('startChatSession', () => {
  const validData = {
    trades: createMockTrades(5),
    accountId: 'acc-1',
    period: 'last30days',
    tradesHash: 'hash-xyz',
  };

  it('throws unauthenticated when no auth context', async () => {
    const request = createUnauthenticatedRequest(validData);

    await expect(startChatSession(request)).rejects.toThrow(/unauthenticated|Authentication required/i);
  });

  it('throws invalid-argument for missing trades', async () => {
    const request = createMockRequest(
      { accountId: 'acc-1', period: 'last30days', tradesHash: 'hash' },
      'user-1',
    );

    await expect(startChatSession(request)).rejects.toThrow(/invalid-argument|trades/i);
  });

  it('throws invalid-argument for empty trades array', async () => {
    const request = createMockRequest(
      { trades: [], accountId: 'acc-1', period: 'last30days', tradesHash: 'hash' },
      'user-1',
    );

    await expect(startChatSession(request)).rejects.toThrow(/invalid-argument|trades/i);
  });

  it('throws invalid-argument for missing accountId', async () => {
    const request = createMockRequest(
      { trades: createMockTrades(3), period: 'last30days', tradesHash: 'hash' },
      'user-1',
    );

    await expect(startChatSession(request)).rejects.toThrow(/invalid-argument|accountId/i);
  });

  it('throws invalid-argument for missing period', async () => {
    const request = createMockRequest(
      { trades: createMockTrades(3), accountId: 'acc-1', tradesHash: 'hash' },
      'user-1',
    );

    await expect(startChatSession(request)).rejects.toThrow(/invalid-argument|period/i);
  });

  it('checks rate limit for chatSessions', async () => {
    const request = createMockRequest(validData, 'user-1');
    await startChatSession(request);

    expect(mockCheckAndIncrementRateLimit).toHaveBeenCalledWith('user-1', 'chatSessions');
  });

  it('throws when rate limited (propagates HttpsError)', async () => {
    mockCheckAndIncrementRateLimit.mockRejectedValue(
      Object.assign(new Error('Rate limit exceeded'), { code: 'resource-exhausted' }),
    );

    const request = createMockRequest(validData, 'user-1');

    await expect(startChatSession(request)).rejects.toThrow(/Rate limit/);
  });

  it('creates session doc with correct fields', async () => {
    const request = createMockRequest(validData, 'user-1');
    await startChatSession(request);

    expect(mockDocSet).toHaveBeenCalledTimes(1);
    const sessionData = mockDocSet.mock.calls[0][0];
    expect(sessionData.accountId).toBe('acc-1');
    expect(sessionData.period).toBe('last30days');
    expect(sessionData.tradesHash).toBe('hash-xyz');
    expect(sessionData.status).toBe('active');
    expect(sessionData.messageCount).toBe(0);
    expect(sessionData.trades).toBeDefined();
    expect(Array.isArray(sessionData.trades)).toBe(true);
  });

  it('truncates trades to 1000 when more are provided', async () => {
    const largeTrades = createMockTrades(1500);
    const request = createMockRequest(
      { ...validData, trades: largeTrades },
      'user-1',
    );
    await startChatSession(request);

    const sessionData = mockDocSet.mock.calls[0][0];
    expect(sessionData.trades.length).toBe(1000);
  });

  it('sets expiresAt to approximately 24 hours from now', async () => {
    const before = Date.now();
    const request = createMockRequest(validData, 'user-1');
    await startChatSession(request);
    const after = Date.now();

    const sessionData = mockDocSet.mock.calls[0][0];
    expect(sessionData.expiresAt).toBeDefined();

    const expiresMs = sessionData.expiresAt.toMillis();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + twentyFourHoursMs - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + twentyFourHoursMs + 5000);
  });

  it('returns sessionId from the auto-generated document', async () => {
    const request = createMockRequest(validData, 'user-1');
    const result = await startChatSession(request);

    expect(result).toEqual({ sessionId: 'auto-session-id-123' });
  });

  it('initial messageCount is 0', async () => {
    const request = createMockRequest(validData, 'user-1');
    await startChatSession(request);

    const sessionData = mockDocSet.mock.calls[0][0];
    expect(sessionData.messageCount).toBe(0);
  });

  it('initial status is active', async () => {
    const request = createMockRequest(validData, 'user-1');
    await startChatSession(request);

    const sessionData = mockDocSet.mock.calls[0][0];
    expect(sessionData.status).toBe('active');
  });
});
