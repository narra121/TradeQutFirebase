import { Timestamp } from 'firebase-admin/firestore';

export interface RateLimitWindow {
  count: number;
  windowStart: Timestamp;
}

export interface RateLimitDocument {
  insightGenerations: RateLimitWindow;
  chatSessions: RateLimitWindow;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  resetAt?: Date;
}
