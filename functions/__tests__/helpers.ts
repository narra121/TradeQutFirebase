/**
 * Shared test helpers for Cloud Functions tests.
 *
 * Provides mock factories for Firebase Auth, Firestore, and Gemini AI
 * so individual test files stay focused on business logic assertions.
 */
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Firebase callable request mock
// ---------------------------------------------------------------------------

export interface MockCallableRequest {
  auth?: { uid: string; token?: Record<string, unknown> };
  data: Record<string, unknown>;
  app?: { appId: string };
}

export function createMockRequest(
  data: Record<string, unknown>,
  uid?: string,
): MockCallableRequest {
  return {
    auth: uid ? { uid, token: {} } : undefined,
    data,
    app: { appId: 'test-app' },
  };
}

export function createUnauthenticatedRequest(
  data: Record<string, unknown>,
): MockCallableRequest {
  return { data, app: { appId: 'test-app' } };
}

// ---------------------------------------------------------------------------
// Firestore document snapshot mock
// ---------------------------------------------------------------------------

export interface MockDocumentSnapshot {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
  id: string;
  ref: { path: string };
}

export function createMockDocSnapshot(
  data: Record<string, unknown> | null,
  id = 'doc-1',
  path = 'test/doc-1',
): MockDocumentSnapshot {
  return {
    exists: data !== null,
    data: () => (data !== null ? { ...data } : undefined),
    id,
    ref: { path },
  };
}

// ---------------------------------------------------------------------------
// Firestore query snapshot mock
// ---------------------------------------------------------------------------

export interface MockQuerySnapshot {
  docs: MockDocumentSnapshot[];
  empty: boolean;
  size: number;
}

export function createMockQuerySnapshot(
  docs: Array<{ data: Record<string, unknown>; id?: string }>,
): MockQuerySnapshot {
  const mockDocs = docs.map((d, i) =>
    createMockDocSnapshot(d.data, d.id ?? `doc-${i}`, `test/${d.id ?? `doc-${i}`}`),
  );
  return {
    docs: mockDocs,
    empty: mockDocs.length === 0,
    size: mockDocs.length,
  };
}

// ---------------------------------------------------------------------------
// Gemini stream mock
// ---------------------------------------------------------------------------

export function createMockStream(chunks: string[]) {
  return {
    stream: (async function* () {
      for (const chunk of chunks) {
        yield { text: () => chunk };
      }
    })(),
  };
}

export function createMockEmptyStream() {
  return {
    stream: (async function* () {
      // yields nothing
    })(),
  };
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

export function mockTimestamp(ms: number) {
  return {
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

export function nowMs(): number {
  return Date.now();
}

export function hoursAgo(hours: number): number {
  return Date.now() - hours * 60 * 60 * 1000;
}

export function hoursFromNow(hours: number): number {
  return Date.now() + hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Trade data factory
// ---------------------------------------------------------------------------

export function createMockTrade(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tradeId: 'trade-1',
    symbol: 'AAPL',
    side: 'long',
    openDate: '2024-01-15',
    closeDate: '2024-01-16',
    pnl: 150.5,
    volume: 100,
    accountId: 'acc-1',
    tags: ['momentum'],
    brokenRules: [],
    mistakes: [],
    lessons: [],
    ...overrides,
  };
}

export function createMockTrades(count: number) {
  return Array.from({ length: count }, (_, i) =>
    createMockTrade({
      tradeId: `trade-${i + 1}`,
      symbol: i % 2 === 0 ? 'AAPL' : 'TSLA',
      pnl: (i % 3 === 0 ? -1 : 1) * (50 + i * 10),
    }),
  );
}

// ---------------------------------------------------------------------------
// Insight response factory
// ---------------------------------------------------------------------------

export function createMockInsightResponse() {
  return {
    profile: {
      type: 'day_trader',
      typeLabel: 'Day Trader',
      aggressivenessScore: 65,
      aggressivenessLabel: 'Medium',
      trend: 'improving',
      summary: 'Active day trader with improving results.',
    },
    scores: [
      { dimension: 'Risk Management', value: 72, label: 'Good' },
      { dimension: 'Consistency', value: 58, label: 'Fair' },
      { dimension: 'Discipline', value: 80, label: 'Good' },
      { dimension: 'Emotional Control', value: 65, label: 'Fair' },
    ],
    insights: [
      {
        severity: 'warning',
        title: 'Overtrading on Mondays',
        detail: 'You trade 40% more on Mondays with lower win rate.',
        evidence: 'Monday win rate: 45% vs 62% other days',
        tradeIds: ['trade-1', 'trade-3'],
      },
    ],
    tradeSpotlights: [
      {
        tradeId: 'trade-1',
        symbol: 'AAPL',
        date: '2024-01-15',
        pnl: 150.5,
        reason: 'Best risk-reward ratio this period.',
      },
    ],
    summary: 'Overall improving performance with room for growth in consistency.',
  };
}
