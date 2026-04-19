import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { chatSessionRef, chatMessagesCol } from './lib/firestore';
import { checkMessageLimit } from './lib/rate-limit';
import { getChatModel, geminiApiKey } from './lib/gemini';
import { CHAT_SYSTEM_PROMPT } from './lib/prompts';
import type { ChatSessionDocument, ChatMessageDocument, TrimmedTrade } from './types/insight';

/** Minimum interval between Firestore writes during streaming (ms) */
const STREAM_WRITE_THROTTLE_MS = 300;

/** Maximum user message length */
const MAX_MESSAGE_LENGTH = 2000;

interface SendChatInput {
  sessionId: string;
  message: string;
}

function validateInput(data: unknown): SendChatInput {
  const d = data as Record<string, unknown>;

  if (typeof d.sessionId !== 'string' || d.sessionId.length === 0) {
    throw new HttpsError('invalid-argument', 'sessionId is required');
  }
  if (typeof d.message !== 'string' || d.message.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'message is required');
  }
  if ((d.message as string).length > MAX_MESSAGE_LENGTH) {
    throw new HttpsError('invalid-argument', `message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`);
  }

  return {
    sessionId: d.sessionId as string,
    message: (d.message as string).trim(),
  };
}

function buildTradeContext(trades: TrimmedTrade[]): string {
  return `Here is the trader's data (${trades.length} trades):\n${JSON.stringify(trades)}`;
}

export const sendChatMessage = onCall(
  {
    enforceAppCheck: false,
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
    const { sessionId, message } = validateInput(request.data);

    // 3. Read session doc and verify ownership + state
    const sessionDocRef = chatSessionRef(userId, sessionId);
    const sessionSnap = await sessionDocRef.get();

    if (!sessionSnap.exists) {
      throw new HttpsError('not-found', 'Chat session not found');
    }

    const session = sessionSnap.data() as ChatSessionDocument;

    // Verify not expired
    if (session.expiresAt.toMillis() < Date.now()) {
      await sessionDocRef.update({ status: 'expired' });
      throw new HttpsError('failed-precondition', 'Chat session has expired. Start a new session.');
    }

    // Verify not currently generating
    if (session.status === 'generating') {
      throw new HttpsError('failed-precondition', 'A message is already being generated. Please wait.');
    }

    // 4. Check message limit
    await checkMessageLimit(userId, sessionId, session.messageCount);

    // 5. Write user message to messages subcollection
    const messagesCol = chatMessagesCol(userId, sessionId);
    const userMessageIndex = session.messageCount;

    const userMessageDoc: ChatMessageDocument = {
      role: 'user',
      text: message,
      createdAt: Timestamp.now(),
      index: userMessageIndex,
    };
    await messagesCol.doc(`msg_${String(userMessageIndex).padStart(4, '0')}`).set(userMessageDoc);

    // 6. Update session: status 'generating', increment messageCount
    await sessionDocRef.update({
      status: 'generating',
      messageCount: FieldValue.increment(1),
    });

    const modelMessageIndex = userMessageIndex + 1;
    const modelMessageRef = messagesCol.doc(`msg_${String(modelMessageIndex).padStart(4, '0')}`);

    try {
      // 7. Read ALL messages from subcollection for full chat history
      const allMessagesSnap = await messagesCol.orderBy('index').get();
      const history = allMessagesSnap.docs.map((doc) => {
        const msg = doc.data() as ChatMessageDocument;
        return {
          role: msg.role as 'user' | 'model',
          parts: [{ text: msg.text }],
        };
      });

      // 8. Build Gemini chat with system prompt + trade context + history
      const model = getChatModel();
      const tradeContext = buildTradeContext(session.trades);

      // Initial context pair: provide trade data as first exchange
      const contextHistory = [
        {
          role: 'user' as const,
          parts: [{ text: `${CHAT_SYSTEM_PROMPT}\n\n${tradeContext}\n\nAcknowledge and be ready to answer.` }],
        },
        {
          role: 'model' as const,
          parts: [{ text: "I've reviewed your trading data. What would you like to know?" }],
        },
        // Append all prior messages from the session
        ...history,
      ];

      // The last message in history is the user message we just wrote,
      // so we use startChat with all history except the last, then send the last
      const chatHistory = contextHistory.slice(0, -1);
      const lastUserMessage = contextHistory[contextHistory.length - 1];

      const chat = model.startChat({ history: chatHistory });

      // 9. Stream response, progressively update model message doc
      const streamResult = await chat.sendMessageStream(lastUserMessage.parts[0].text);

      // Create initial model message doc
      const initialModelDoc: ChatMessageDocument = {
        role: 'model',
        text: '',
        createdAt: Timestamp.now(),
        index: modelMessageIndex,
      };
      await modelMessageRef.set(initialModelDoc);

      let accumulatedText = '';
      let lastWriteTime = 0;

      for await (const chunk of streamResult.stream) {
        const text = chunk.text();
        if (!text) continue;
        accumulatedText += text;

        // Throttle Firestore writes to every 300ms
        const now = Date.now();
        if (now - lastWriteTime >= STREAM_WRITE_THROTTLE_MS) {
          await modelMessageRef.update({ text: accumulatedText });
          lastWriteTime = now;
        }
      }

      // 10. Final write: complete text + update session status
      await modelMessageRef.update({ text: accumulatedText });
      await sessionDocRef.update({
        status: 'active',
        messageCount: FieldValue.increment(1),
      });

      logger.info('Chat message processed', {
        userId,
        sessionId,
        messageIndex: modelMessageIndex,
        responseLength: accumulatedText.length,
      });

      return { success: true, messageIndex: modelMessageIndex };
    } catch (error) {
      // 11. On error: set session status back to 'active', clean up model message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Chat message failed', { userId, sessionId, error: errorMessage });

      await sessionDocRef.update({ status: 'active' });

      // Write error to model message doc so frontend can show it
      await modelMessageRef.set({
        role: 'model',
        text: 'Sorry, I encountered an error generating a response. Please try again.',
        createdAt: Timestamp.now(),
        index: modelMessageIndex,
      });

      // Still increment messageCount for the model message
      await sessionDocRef.update({
        messageCount: FieldValue.increment(1),
      });

      throw new HttpsError('internal', 'Failed to generate chat response. Please try again.');
    }
  },
);
