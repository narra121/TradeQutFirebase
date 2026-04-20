import { Timestamp } from 'firebase-admin/firestore';

// -------------------------------------------------------------------------
// Trade data shape (mirrors frontend TrimmedTrade from ai.ts)
// -------------------------------------------------------------------------

export interface TrimmedTrade {
  tradeId: string;
  symbol: string;
  side: string;
  openDate: string;
  closeDate: string;
  pnl: number;
  volume: number;
  accountId?: string;
  tags?: string[];
  brokenRules?: string[];
  mistakes?: string[];
  lessons?: string[];
}

// -------------------------------------------------------------------------
// Insight report types (mirrors frontend InsightsResponse from insights.ts)
// -------------------------------------------------------------------------

export interface TraderProfile {
  type: 'scalper' | 'day_trader' | 'swing_trader' | 'conservative';
  typeLabel: string;
  aggressivenessScore: number;
  aggressivenessLabel: string;
  trend: string | null;
  summary: string;
}

export interface BehavioralScore {
  dimension: string;
  value: number;
  label: string;
}

export interface Insight {
  severity: 'critical' | 'warning' | 'info' | 'strength';
  title: string;
  detail: string;
  evidence: string;
  tradeIds?: string[];
}

export interface TradeSpotlight {
  tradeId: string;
  symbol: string;
  date: string;
  pnl: number;
  reason: string;
}

export interface InsightsResponse {
  profile: TraderProfile;
  scores: BehavioralScore[];
  insights: Insight[];
  tradeSpotlights: TradeSpotlight[];
  summary: string;
}

// -------------------------------------------------------------------------
// Firestore document types
// -------------------------------------------------------------------------

export type InsightStatus = 'generating' | 'complete' | 'error';

export interface InsightDocument {
  status: InsightStatus;
  tradesHash: string;
  accountId: string;
  period: string;
  generatedAt: Timestamp;
  error?: string;
  summary?: string;
  profile?: TraderProfile;
  scores?: BehavioralScore[];
  insights?: Insight[];
  tradeSpotlights?: TradeSpotlight[];
  patterns?: Record<string, unknown>;
}

// -------------------------------------------------------------------------
// Chat session types
// -------------------------------------------------------------------------

export type ChatSessionStatus = 'active' | 'generating' | 'expired';

export interface ChatSessionDocument {
  accountId: string;
  period: string;
  trades: TrimmedTrade[];
  tradesHash: string;
  messageCount: number;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  status: ChatSessionStatus;
  title?: string;
  insightId?: string;
  insightsData?: string;
}

export interface ChatMessageDocument {
  role: 'user' | 'model';
  text: string;
  createdAt: Timestamp;
  index: number;
}
