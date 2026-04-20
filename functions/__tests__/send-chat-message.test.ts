import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockRequest,
  createUnauthenticatedRequest,
  createMockDocSnapshot,
  createMockQuerySnapshot,
  createMockStream,
  createMockTrades,
  mockTimestamp,
  hoursFromNow,
  hoursAgo,
} from './helpers';

// ---------------------------------------------------------------------------
// Firestore mock
// ---------------------------------------------------------------------------

const mockSessionGet = vi.fn();
const mockSessionUpdate = vi.fn().mockResolvedValue(undefined);
const mockSessionDocRef = {
  get: mockSessionGet,
  set: vi.fn().mockResolvedValue(undefined),
  update: mockSessionUpdate,
  id: 'session-1',
};

const mockMsgDocSet = vi.fn().mockResolvedValue(undefined);
const mockMsgDocUpdate = vi.fn().mockResolvedValue(undefined);
const mockMsgDocRef = {
  set: mockMsgDocSet,
  update: mockMsgDocUpdate,
  id: 'msg_0004',
};

const mockMessagesOrderBy = vi.fn();
const mockMessagesGet = vi.fn();
const mockMessagesCollectionRef = {
  doc: vi.fn().mockReturnValue(mockMsgDocRef),
  orderBy: mockMessagesOrderBy,
  get: mockMessagesGet,
};

// orderBy returns an object with .get()
mockMessagesOrderBy.mockReturnValue({ get: mockMessagesGet });

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
// Mock lib/firestore
// ---------------------------------------------------------------------------

vi.mock('../src/lib/firestore', () => ({
  getDb: vi.fn(),
  chatSessionRef: () => mockSessionDocRef,
  chatMessagesCol: () => mockMessagesCollectionRef,
}));

// ---------------------------------------------------------------------------
// Mock lib/rate-limit
// ---------------------------------------------------------------------------

const mockCheckMessageLimit = vi.fn();

vi.mock('../src/lib/rate-limit', () => ({
  checkAndIncrementRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 5 }),
  checkMessageLimit: (...args: unknown[]) => mockCheckMessageLimit(...args),
}));

// ---------------------------------------------------------------------------
// Mock lib/gemini
// ---------------------------------------------------------------------------

const mockSendMessageStream = vi.fn();
const mockStartChat = vi.fn().mockReturnValue({
  sendMessageStream: mockSendMessageStream,
});

vi.mock('../src/lib/gemini', () => ({
  getChatModel: () => ({ startChat: mockStartChat }),
  geminiApiKey: { value: () => 'test-key' },
}));

// ---------------------------------------------------------------------------
// Mock lib/prompts
// ---------------------------------------------------------------------------

vi.mock('../src/lib/prompts', () => ({
  CHAT_SYSTEM_PROMPT: 'You are an expert trading coach.',
}));

// ---------------------------------------------------------------------------
// Helper: create a valid active session
// ---------------------------------------------------------------------------

function createActiveSession(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1',
    period: 'last30days',
    status: 'active',
    messageCount: 4,
    createdAt: mockTimestamp(Date.now()),
    expiresAt: mockTimestamp(hoursFromNow(20)),
    trades: createMockTrades(5),
    tradesHash: 'hash-xyz',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import (triggers onCall registration)
// ---------------------------------------------------------------------------

import { sendChatMessage } from '../src/send-chat-message';

beforeEach(() => {
  vi.clearAllMocks();

  // Default: message limit passes (no throw)
  mockCheckMessageLimit.mockResolvedValue(undefined);

  // Default: session exists and is active
  mockSessionGet.mockResolvedValue(
    createMockDocSnapshot(createActiveSession(), 'session-1'),
  );

  // Default: empty messages
  mockMessagesGet.mockResolvedValue(createMockQuerySnapshot([]));

  // Re-wire orderBy chain
  mockMessagesOrderBy.mockReturnValue({ get: mockMessagesGet });

  // Default: Gemini returns a stream
  mockSendMessageStream.mockResolvedValue(
    createMockStream(['Hello! ', 'Here is my response.']),
  );

  // Ensure doc returns our mock ref
  mockMessagesCollectionRef.doc.mockReturnValue(mockMsgDocRef);
});

describe('sendChatMessage', () => {
  const validData = {
    sessionId: 'session-1',
    message: 'What patterns do you see in my trades?',
  };

  it('throws unauthenticated when no auth context', async () => {
    const request = createUnauthenticatedRequest(validData);

    await expect(sendChatMessage(request)).rejects.toThrow(/unauthenticated|Authentication required/i);
  });

  it('throws invalid-argument for missing sessionId', async () => {
    const request = createMockRequest({ message: 'Hello' }, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow(/invalid-argument|sessionId/i);
  });

  it('throws invalid-argument for missing message', async () => {
    const request = createMockRequest({ sessionId: 'session-1' }, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow(/invalid-argument|message/i);
  });

  it('throws invalid-argument for empty whitespace-only message', async () => {
    const request = createMockRequest({ sessionId: 'session-1', message: '   ' }, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow(/invalid-argument|message/i);
  });

  it('throws not-found for non-existent session', async () => {
    mockSessionGet.mockResolvedValue(createMockDocSnapshot(null));

    const request = createMockRequest(validData, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow(/not-found|Chat session not found/i);
  });

  it('throws failed-precondition for expired session', async () => {
    mockSessionGet.mockResolvedValue(
      createMockDocSnapshot(
        createActiveSession({
          expiresAt: mockTimestamp(hoursAgo(1)),
        }),
        'session-1',
      ),
    );

    const request = createMockRequest(validData, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow(/failed-precondition|expired/i);
  });

  it('updates session to expired status when session has expired', async () => {
    mockSessionGet.mockResolvedValue(
      createMockDocSnapshot(
        createActiveSession({
          expiresAt: mockTimestamp(hoursAgo(1)),
        }),
        'session-1',
      ),
    );

    const request = createMockRequest(validData, 'user-1');

    try { await sendChatMessage(request); } catch { /* expected */ }

    const expiredUpdate = mockSessionUpdate.mock.calls.find(
      (call) => call[0].status === 'expired',
    );
    expect(expiredUpdate).toBeDefined();
  });

  it('throws failed-precondition when session status is generating', async () => {
    mockSessionGet.mockResolvedValue(
      createMockDocSnapshot(
        createActiveSession({ status: 'generating' }),
        'session-1',
      ),
    );

    const request = createMockRequest(validData, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow(/failed-precondition|generated|already being/i);
  });

  it('checks message limit with current messageCount', async () => {
    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    expect(mockCheckMessageLimit).toHaveBeenCalledWith('user-1', 'session-1', 4);
  });

  it('throws resource-exhausted when message limit reached', async () => {
    mockCheckMessageLimit.mockRejectedValue(
      Object.assign(new Error('Message limit reached'), { code: 'resource-exhausted' }),
    );

    const request = createMockRequest(validData, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow(/Message limit|resource-exhausted/i);
  });

  it('writes user message to messages subcollection with correct fields', async () => {
    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    // Find the user message set call
    const userMsgWrite = mockMsgDocSet.mock.calls.find(
      (call) => call[0].role === 'user',
    );
    expect(userMsgWrite).toBeDefined();
    expect(userMsgWrite![0].text).toBe('What patterns do you see in my trades?');
    expect(userMsgWrite![0].index).toBe(4); // messageCount was 4
    expect(userMsgWrite![0].role).toBe('user');
  });

  it('sets session status to generating after writing user message', async () => {
    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    const generatingUpdate = mockSessionUpdate.mock.calls.find(
      (call) => call[0].status === 'generating',
    );
    expect(generatingUpdate).toBeDefined();
  });

  it('reads all prior messages ordered by index for chat context', async () => {
    mockMessagesGet.mockResolvedValue(
      createMockQuerySnapshot([
        { data: { role: 'user', text: 'Previous question', index: 0, createdAt: mockTimestamp(Date.now()) }, id: 'msg_0000' },
        { data: { role: 'model', text: 'Previous answer', index: 1, createdAt: mockTimestamp(Date.now()) }, id: 'msg_0001' },
        { data: { role: 'user', text: validData.message, index: 4, createdAt: mockTimestamp(Date.now()) }, id: 'msg_0004' },
      ]),
    );

    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    expect(mockMessagesOrderBy).toHaveBeenCalledWith('index');
    expect(mockMessagesGet).toHaveBeenCalled();
  });

  it('calls Gemini with chat history including system prompt and trade context', async () => {
    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    expect(mockStartChat).toHaveBeenCalledTimes(1);
    const chatOptions = mockStartChat.mock.calls[0][0];
    expect(chatOptions.history).toBeDefined();
    // History includes the context pair minus the last message (which is sent via sendMessageStream)
    // With empty messages, contextHistory = [user-context, model-ack, user-msg], chatHistory = first 2
    // But our mock returns empty messages so the user message we just wrote also appears
    expect(chatOptions.history.length).toBeGreaterThanOrEqual(1);

    // First entry should contain system prompt + trade context
    const firstEntry = chatOptions.history[0];
    expect(firstEntry.role).toBe('user');
    expect(firstEntry.parts[0].text).toContain('trading coach');
  });

  it('creates initial model message doc with empty text', async () => {
    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    const modelMsgWrite = mockMsgDocSet.mock.calls.find(
      (call) => call[0].role === 'model' && call[0].text === '',
    );
    expect(modelMsgWrite).toBeDefined();
    expect(modelMsgWrite![0].index).toBe(5); // messageCount=4, user=4, model=5
  });

  it('progressively updates model message text during streaming', async () => {
    mockSendMessageStream.mockResolvedValue(
      createMockStream(['Chunk 1. ', 'Chunk 2. ', 'Chunk 3.']),
    );

    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    // Final write should contain all accumulated text
    const textUpdates = mockMsgDocUpdate.mock.calls.filter(
      (call) => call[0].text !== undefined,
    );
    expect(textUpdates.length).toBeGreaterThanOrEqual(1);
    const lastTextUpdate = textUpdates[textUpdates.length - 1][0].text;
    expect(lastTextUpdate).toContain('Chunk 1.');
    expect(lastTextUpdate).toContain('Chunk 3.');
  });

  it('sets session status back to active after successful completion', async () => {
    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    const allSessionUpdates = mockSessionUpdate.mock.calls;
    const lastActiveUpdate = [...allSessionUpdates].reverse().find(
      (call) => call[0].status === 'active',
    );
    expect(lastActiveUpdate).toBeDefined();
  });

  it('increments messageCount via FieldValue.increment for both user and model messages', async () => {
    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    // FieldValue.increment(1) is used in update calls
    const incrementUpdates = mockSessionUpdate.mock.calls.filter(
      (call) => call[0].messageCount !== undefined,
    );
    // Should be exactly 2: once after user message, once after model message
    expect(incrementUpdates.length).toBe(2);
  });

  it('recovers session status to active on Gemini error', async () => {
    mockSendMessageStream.mockRejectedValue(new Error('Gemini failure'));

    const request = createMockRequest(validData, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow();

    const recoveryUpdate = mockSessionUpdate.mock.calls.find(
      (call) => call[0].status === 'active',
    );
    expect(recoveryUpdate).toBeDefined();
  });

  it('writes fallback error message to model message doc on failure', async () => {
    mockSendMessageStream.mockRejectedValue(new Error('Gemini failure'));

    const request = createMockRequest(validData, 'user-1');

    await expect(sendChatMessage(request)).rejects.toThrow();

    const errorMsgWrite = mockMsgDocSet.mock.calls.find(
      (call) => call[0].role === 'model' && call[0].text.includes('error'),
    );
    expect(errorMsgWrite).toBeDefined();
  });

  it('returns { success: true, messageIndex } on completion', async () => {
    const request = createMockRequest(validData, 'user-1');
    const result = await sendChatMessage(request);

    expect(result.success).toBe(true);
    expect(result.messageIndex).toBe(5); // messageCount=4 -> user=4, model=5
  });

  it('sets session title from first user message when messageCount is 0', async () => {
    mockSessionGet.mockResolvedValue(
      createMockDocSnapshot(
        createActiveSession({ messageCount: 0 }),
        'session-1',
      ),
    );

    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    const generatingUpdate = mockSessionUpdate.mock.calls.find(
      (call) => call[0].status === 'generating' && call[0].title !== undefined,
    );
    expect(generatingUpdate).toBeDefined();
    expect(generatingUpdate![0].title).toBe('What patterns do you see in my trades?');
  });

  it('truncates session title to 50 characters on first message', async () => {
    mockSessionGet.mockResolvedValue(
      createMockDocSnapshot(
        createActiveSession({ messageCount: 0 }),
        'session-1',
      ),
    );

    const longMessage = 'A'.repeat(100);
    const request = createMockRequest({ sessionId: 'session-1', message: longMessage }, 'user-1');
    await sendChatMessage(request);

    const generatingUpdate = mockSessionUpdate.mock.calls.find(
      (call) => call[0].status === 'generating' && call[0].title !== undefined,
    );
    expect(generatingUpdate).toBeDefined();
    expect(generatingUpdate![0].title).toBe('A'.repeat(50));
  });

  it('does not set title on subsequent messages (messageCount > 0)', async () => {
    // Default session has messageCount=4
    const request = createMockRequest(validData, 'user-1');
    await sendChatMessage(request);

    const generatingUpdate = mockSessionUpdate.mock.calls.find(
      (call) => call[0].status === 'generating',
    );
    expect(generatingUpdate).toBeDefined();
    expect(generatingUpdate![0].title).toBeUndefined();
  });
});
