# TradeQutFirebase

Firebase Cloud Functions + Firestore backend for TradeQut AI Insights.

## Architecture

- **Cloud Functions**: Server-side Gemini API calls with progressive Firestore writes
- **Firestore**: Real-time data sync via onSnapshot for insights, chat sessions, and rate limits
- **Terraform**: Infrastructure as Code for Firebase project, Firestore, IAM

## Cloud Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `generateInsight` | HTTPS Callable | AI trading report with progressive Firestore field writes |
| `startChatSession` | HTTPS Callable | Create chat session with trades stored in Firestore (24hr TTL) |
| `sendChatMessage` | HTTPS Callable | Send message, stream Gemini response to Firestore |

## Firestore Collections

| Path | Purpose |
|------|---------|
| `/users/{uid}/insights/{id}` | Cached AI reports (progressive fields) |
| `/users/{uid}/chatSessions/{id}` | Chat sessions with 24hr TTL auto-delete |
| `/users/{uid}/chatSessions/{id}/messages/{idx}` | Chat messages ordered by index |
| `/users/{uid}/rateLimits/current` | Rate limit counters (6 insights/6hr, 6 sessions/6hr) |

## Rate Limits

- 6 insight generations per 6 hours
- 6 chat sessions per 6 hours
- 25 messages per session

## Development

```bash
cd functions
npm install
npm test          # Run tests (69 tests)
npm run build     # Compile TypeScript
```

## Deployment

- **Dev**: Auto-deploys on push to `main`
- **Prod**: Manual workflow dispatch with confirmation

## Infrastructure

Terraform manages: Firebase project, Firestore database, IAM roles, Secret Manager API.

GCP Project (dev): `gen-lang-client-0672520490`
