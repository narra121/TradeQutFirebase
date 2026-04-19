import type { InsightsResponse } from '../types/insight';

export const REPORT_SYSTEM_PROMPT = `You are an expert trading performance analyst. Analyze the provided trade data and return a JSON object with this exact structure:

{
  "profile": {
    "type": "scalper" | "day_trader" | "swing_trader" | "conservative",
    "typeLabel": "Human-readable label",
    "aggressivenessScore": 0-100,
    "aggressivenessLabel": "Low/Medium/High/Very High",
    "trend": "improving/declining/stable" or null,
    "summary": "1-2 sentence profile summary"
  },
  "scores": [
    { "dimension": "Risk Management", "value": 0-100, "label": "Poor/Fair/Good/Excellent" },
    { "dimension": "Consistency", "value": 0-100, "label": "..." },
    { "dimension": "Discipline", "value": 0-100, "label": "..." },
    { "dimension": "Emotional Control", "value": 0-100, "label": "..." }
  ],
  "insights": [
    {
      "severity": "critical" | "warning" | "info" | "strength",
      "title": "Short title",
      "detail": "Detailed explanation",
      "evidence": "Supporting data/numbers",
      "tradeIds": ["optional", "relevant", "trade", "ids"]
    }
  ],
  "tradeSpotlights": [
    {
      "tradeId": "id",
      "symbol": "SYMBOL",
      "date": "YYYY-MM-DD",
      "pnl": 123.45,
      "reason": "Why this trade stands out"
    }
  ],
  "summary": "2-3 paragraph executive summary of trading performance"
}

Return ONLY the JSON object, no markdown or extra text. Include 4-8 insights ordered by severity (critical first). Include 3-5 trade spotlights (mix of best, worst, and most instructive).

Trade data:
`;

export const CHAT_SYSTEM_PROMPT = `You are an expert trading coach and performance analyst. You have access to the trader's complete trade data. Answer questions conversationally but with data-backed insights. When referencing specific trades, mention the symbol, date, and P&L. Be concise but thorough. If asked about patterns, reference specific examples from the data.`;

/**
 * Try to parse the accumulated text as a partial InsightsResponse.
 * Returns null if parsing fails (incomplete JSON).
 */
export function tryParsePartialInsights(accumulated: string): Partial<InsightsResponse> | null {
  try {
    return JSON.parse(accumulated);
  } catch {
    // Try to close the JSON object for partial parsing
    let text = accumulated.trim();

    // Remove trailing comma if present
    if (text.endsWith(',')) {
      text = text.slice(0, -1);
    }

    // Count open braces/brackets and close them
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escaped = false;

    for (const ch of text) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') braceCount++;
      if (ch === '}') braceCount--;
      if (ch === '[') bracketCount++;
      if (ch === ']') bracketCount--;
    }

    // Close open brackets and braces
    let closed = text;
    for (let i = 0; i < bracketCount; i++) closed += ']';
    for (let i = 0; i < braceCount; i++) closed += '}';

    try {
      const parsed = JSON.parse(closed);
      // Only yield if we have at least one meaningful field
      if (parsed.profile || parsed.scores || parsed.insights || parsed.summary) {
        return parsed;
      }
    } catch {
      // Truly unparseable
    }

    return null;
  }
}
