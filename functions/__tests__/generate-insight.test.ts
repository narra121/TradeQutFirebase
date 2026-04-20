import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockRequest,
  createUnauthenticatedRequest,
  createMockDocSnapshot,
  createMockTrades,
  createMockInsightResponse,
  createMockStream,
  createMockEmptyStream,
  mockTimestamp,
  nowMs,
} from './helpers';

// ---------------------------------------------------------------------------
// Firestore mock
// ---------------------------------------------------------------------------

const mockDocGet = vi.fn();
const mockDocSet = vi.fn().mockResolvedValue(undefined);
const mockDocUpdate = vi.fn().mockResolvedValue(undefined);
const insightDocRef = {
  get: mockDocGet,
  set: mockDocSet,
  update: mockDocUpdate,
  id: 'acc-1_last30days',
};

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
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
// Firebase Functions mock - capture the onCall handler
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
// Mock lib/firestore - return our mock doc ref from insightRef
// ---------------------------------------------------------------------------

vi.mock('../src/lib/firestore', () => ({
  getDb: vi.fn(),
  insightRef: vi.fn(() => insightDocRef),
  chatSessionRef: vi.fn(),
  chatMessagesCol: vi.fn(),
  rateLimitRef: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock lib/rate-limit
// ---------------------------------------------------------------------------

const mockCheckAndIncrementRateLimit = vi.fn();

vi.mock('../src/lib/rate-limit', () => ({
  checkAndIncrementRateLimit: (...args: unknown[]) => mockCheckAndIncrementRateLimit(...args),
}));

// ---------------------------------------------------------------------------
// Mock lib/gemini
// ---------------------------------------------------------------------------

const mockGenerateContentStream = vi.fn();

vi.mock('../src/lib/gemini', () => ({
  getReportModel: () => ({ generateContentStream: mockGenerateContentStream }),
  geminiApiKey: { value: () => 'test-key' },
}));

// ---------------------------------------------------------------------------
// Mock lib/prompts
// ---------------------------------------------------------------------------

const mockTryParsePartialInsights = vi.fn();

vi.mock('../src/lib/prompts', () => ({
  REPORT_SYSTEM_PROMPT: 'You are an expert trading performance analyst. Trade data:\n',
  tryParsePartialInsights: (...args: unknown[]) => mockTryParsePartialInsights(...args),
}));

// ---------------------------------------------------------------------------
// Import the module (triggers onCall, generateInsight is set)
// ---------------------------------------------------------------------------

import { generateInsight } from '../src/generate-insight';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: rate limit allows
  mockCheckAndIncrementRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 5,
    resetAt: new Date(),
  });

  // Default: no existing insight (cache miss)
  mockDocGet.mockResolvedValue(createMockDocSnapshot(null));

  // Default: Gemini returns complete JSON in one chunk
  const fullResponse = JSON.stringify(createMockInsightResponse());
  mockGenerateContentStream.mockResolvedValue(createMockStream([fullResponse]));

  // Default: tryParsePartialInsights returns parsed data
  mockTryParsePartialInsights.mockImplementation((text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (parsed.profile || parsed.scores || parsed.insights || parsed.summary) {
        return parsed;
      }
    } catch {
      // no-op
    }
    return null;
  });
});

describe('generateInsight', () => {
  const validData = {
    trades: createMockTrades(5),
    accountId: 'acc-1',
    period: 'last30days',
    tradesHash: 'abc123hash',
  };

  it('throws unauthenticated when no auth context', async () => {
    const request = createUnauthenticatedRequest(validData);

    await expect(generateInsight(request)).rejects.toThrow(/unauthenticated|Authentication required/i);
  });

  it('throws invalid-argument for missing trades field', async () => {
    const request = createMockRequest(
      { accountId: 'acc-1', period: 'last30days', tradesHash: 'hash' },
      'user-1',
    );

    await expect(generateInsight(request)).rejects.toThrow(/invalid-argument|trades/i);
  });

  it('throws invalid-argument for empty trades array', async () => {
    const request = createMockRequest(
      { trades: [], accountId: 'acc-1', period: 'last30days', tradesHash: 'hash' },
      'user-1',
    );

    await expect(generateInsight(request)).rejects.toThrow(/invalid-argument|trades/i);
  });

  it('throws invalid-argument for missing tradesHash', async () => {
    const request = createMockRequest(
      { trades: createMockTrades(3), accountId: 'acc-1', period: 'last30days' },
      'user-1',
    );

    await expect(generateInsight(request)).rejects.toThrow(/invalid-argument|tradesHash/i);
  });

  it('returns cached insight when tradesHash matches and status is complete', async () => {
    const cachedInsight = {
      status: 'complete',
      tradesHash: 'abc123hash',
      accountId: 'acc-1',
      period: 'last30days',
      generatedAt: mockTimestamp(nowMs()),
      ...createMockInsightResponse(),
    };
    mockDocGet.mockResolvedValue(createMockDocSnapshot(cachedInsight, 'acc-1_last30days'));

    const request = createMockRequest(validData, 'user-1');
    const result = await generateInsight(request);

    expect(result.cached).toBe(true);
    expect(result.insightId).toBe('acc-1_last30days');
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementRateLimit).not.toHaveBeenCalled();
  });

  it('does not return cache when tradesHash differs', async () => {
    const existingInsight = {
      status: 'complete',
      tradesHash: 'different-hash',
      accountId: 'acc-1',
      period: 'last30days',
      generatedAt: mockTimestamp(nowMs()),
    };
    mockDocGet.mockResolvedValue(createMockDocSnapshot(existingInsight, 'acc-1_last30days'));

    const request = createMockRequest(validData, 'user-1');
    const result = await generateInsight(request);

    expect(result.cached).toBe(false);
    expect(mockGenerateContentStream).toHaveBeenCalled();
  });

  it('checks and increments rate limit before generating a new insight', async () => {
    const request = createMockRequest(validData, 'user-1');
    await generateInsight(request);

    expect(mockCheckAndIncrementRateLimit).toHaveBeenCalledWith('user-1', 'insightGenerations');
  });

  it('propagates HttpsError when rate limited', async () => {
    // Simulate the rate limiter throwing HttpsError
    mockCheckAndIncrementRateLimit.mockRejectedValue(
      Object.assign(new Error('Rate limit exceeded'), { code: 'resource-exhausted' }),
    );

    const request = createMockRequest(validData, 'user-1');

    // checkAndIncrementRateLimit throws before generation starts
    await expect(generateInsight(request)).rejects.toThrow();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it('writes initial generating status to Firestore before streaming', async () => {
    const request = createMockRequest(validData, 'user-1');
    await generateInsight(request);

    expect(mockDocSet).toHaveBeenCalled();
    const firstSetCall = mockDocSet.mock.calls[0][0];
    expect(firstSetCall.status).toBe('generating');
    expect(firstSetCall.tradesHash).toBe('abc123hash');
    expect(firstSetCall.accountId).toBe('acc-1');
    expect(firstSetCall.period).toBe('last30days');
  });

  it('calls Gemini generateContentStream with system prompt plus trades JSON', async () => {
    const request = createMockRequest(validData, 'user-1');
    await generateInsight(request);

    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
    const prompt = mockGenerateContentStream.mock.calls[0][0];
    expect(prompt).toContain('trading performance analyst');
    expect(prompt).toContain('trade-1');
  });

  it('progressively writes new fields to Firestore as they stream in', async () => {
    let callCount = 0;
    const fullResponse = createMockInsightResponse();
    mockTryParsePartialInsights.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { profile: fullResponse.profile };
      if (callCount === 2) return { profile: fullResponse.profile, scores: fullResponse.scores };
      return fullResponse;
    });

    mockGenerateContentStream.mockResolvedValue(
      createMockStream(['chunk1', 'chunk2', 'chunk3']),
    );

    const request = createMockRequest(validData, 'user-1');
    await generateInsight(request);

    // Should have intermediate update calls for progressive fields
    const intermediateUpdates = mockDocUpdate.mock.calls.filter(
      (call) => call[0].status === undefined,
    );
    expect(intermediateUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it('writes final complete status after stream finishes', async () => {
    const request = createMockRequest(validData, 'user-1');
    await generateInsight(request);

    const allUpdates = mockDocUpdate.mock.calls;
    const finalUpdate = allUpdates[allUpdates.length - 1][0];
    expect(finalUpdate.status).toBe('complete');
  });

  it('writes error status on Gemini failure and re-throws', async () => {
    mockGenerateContentStream.mockRejectedValue(new Error('Gemini API error'));

    const request = createMockRequest(validData, 'user-1');

    await expect(generateInsight(request)).rejects.toThrow(/Insight generation failed/);

    const errorUpdate = mockDocUpdate.mock.calls.find(
      (call) => call[0].status === 'error',
    );
    expect(errorUpdate).toBeDefined();
    expect(errorUpdate![0].error).toContain('Gemini API error');
  });

  it('returns { cached: false, insightId } on successful generation', async () => {
    const request = createMockRequest(validData, 'user-1');
    const result = await generateInsight(request);

    expect(result.cached).toBe(false);
    expect(result.insightId).toBe('acc-1_last30days');
  });

  it('builds insightId deterministically from accountId and period', async () => {
    const request = createMockRequest(
      { ...validData, accountId: 'myacc', period: 'last7days' },
      'user-1',
    );
    const result = await generateInsight(request);

    expect(result.insightId).toBe('myacc_last7days');
  });

  it('rejects trades array exceeding MAX_TRADES (2000)', async () => {
    const request = createMockRequest(
      { ...validData, trades: createMockTrades(2001) },
      'user-1',
    );

    await expect(generateInsight(request)).rejects.toThrow(/invalid-argument|exceeds maximum/i);
  });

  it('handles empty stream response by writing error status', async () => {
    mockGenerateContentStream.mockResolvedValue(createMockEmptyStream());
    // Empty stream + no accumulated text -> final parse fails
    mockTryParsePartialInsights.mockReturnValue(null);

    const request = createMockRequest(validData, 'user-1');

    await expect(generateInsight(request)).rejects.toThrow(/Insight generation failed/);

    const errorUpdate = mockDocUpdate.mock.calls.find(
      (call) => call[0].status === 'error',
    );
    expect(errorUpdate).toBeDefined();
  });

  it('handles malformed JSON from Gemini by writing error status', async () => {
    mockGenerateContentStream.mockResolvedValue(
      createMockStream(['{ this is not valid json !!!']),
    );
    mockTryParsePartialInsights.mockReturnValue(null);

    const request = createMockRequest(validData, 'user-1');

    await expect(generateInsight(request)).rejects.toThrow(/Insight generation failed/);

    const errorUpdate = mockDocUpdate.mock.calls.find(
      (call) => call[0].status === 'error',
    );
    expect(errorUpdate).toBeDefined();
  });

  it('rate limit is incremented atomically before generation (even on Gemini failure)', async () => {
    mockGenerateContentStream.mockRejectedValue(new Error('Gemini API error'));

    const request = createMockRequest(validData, 'user-1');

    await expect(generateInsight(request)).rejects.toThrow(/Insight generation failed/);

    // With atomic check-and-increment, the rate limit is consumed before generation starts
    expect(mockCheckAndIncrementRateLimit).toHaveBeenCalledWith('user-1', 'insightGenerations');
    expect(mockCheckAndIncrementRateLimit).toHaveBeenCalledTimes(1);
  });

  it('calls checkAndIncrementRateLimit exactly once on successful generation', async () => {
    const request = createMockRequest(validData, 'user-1');
    await generateInsight(request);

    expect(mockCheckAndIncrementRateLimit).toHaveBeenCalledWith('user-1', 'insightGenerations');
    expect(mockCheckAndIncrementRateLimit).toHaveBeenCalledTimes(1);
  });

  it('rate limit is consumed before generation on empty stream failure', async () => {
    mockGenerateContentStream.mockResolvedValue(createMockEmptyStream());
    mockTryParsePartialInsights.mockReturnValue(null);

    const request = createMockRequest(validData, 'user-1');

    await expect(generateInsight(request)).rejects.toThrow(/Insight generation failed/);

    expect(mockCheckAndIncrementRateLimit).toHaveBeenCalledTimes(1);
  });
});
