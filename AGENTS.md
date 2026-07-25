# SalesPintar — Agent Guide

## Dev Commands (run from repo root)

| Command | What it does |
|---------|-------------|
| `npm run setup` | Start infra (PostgreSQL+Redis), generate Prisma client, run migrations |
| `npm run dev` | Infra up → start backend (port 3000) + frontend (port 5173) concurrently |
| `npm run dev:backend` | `cd backend && tsx watch src/server.ts` (kills port 3000 first) |
| `npm run dev:frontend` | `cd frontend && vite` |
| `npm run infra:up` | `docker compose -f docker-compose.dev.yml up -d` (PostgreSQL host-network + Redis) |
| `npm run db:migrate` | `cd backend && npx prisma migrate dev --name init` |
| `npm run db:generate` | `cd backend && npx prisma generate` |

**Startup order:** `infra:up` → `db:generate` → `db:migrate` → backend + frontend.

## Architecture

- **Root:** Orchestration only (`package.json` scripts, top-level Docker Compose). No own source.
- **`backend/`:** Express + Prisma + Baileys + BullMQ. **CommonJS** (`tsconfig.json` `module: "commonjs"`, no `"type": "module"`).
  - Entry: `backend/src/server.ts` → bootstraps DB, Redis, workers, Baileys, HTTP+WebSocket.
  - All Prisma queries MUST filter by `businessId` from JWT (row-level auth). Every model carries `businessId`.
  - Zod validates ALL inputs (env vars at startup, all request bodies/params).
  - Custom error classes: `AppError` → `NotFoundError` (404), `ConflictError` (409), `UnauthorizedError` (401), `ForbiddenError` (403), `ValidationError` (400).
  - Services/auth middleware attach `req.user = { userId, businessId, role }`.
- **`frontend/`:** React 19 + Vite + Tailwind + TanStack Query + Zustand. **ESM** (`"type": "module"` in package.json).
  - Vite proxies `/api` and `/socket.io` to `localhost:3000`.
  - Path alias `@/` → `./src/`.
- **Infra:** Docker Compose (prod: `docker-compose.yml`, dev: `docker-compose.dev.yml`). Dev uses `network_mode: host`.
- **WA sessions:** Stored in `./wa_sessions/<business_id>/` (FS) + DB `wa_credentials.session_data`. Volume-mounted for persistence.
- **WebSocket:** Socket.IO, room-based per business (`business:{businessId}`). Events: `chat:new`, `chat:status`, `broadcast:progress`.

## Redis (two clients)

| Client | Env var | Default URL | Purpose |
|--------|---------|-------------|---------|
| `redisCache` | `REDIS_URL` | `redis://localhost:6379` | General caching (dashboard stats/trends, 300s TTL) |
| `redisBull` | `REDIS_BULL_URL` | `redis://localhost:6379/1` | BullMQ queue backend |

Cache keys prefixed `{businessId}:*`.

## Queues (BullMQ, uses `redisBull`)

| Queue | Concurrency | Purpose |
|-------|-----------|---------|
| `ai-reply` | 5 | Groq auto-reply |
| `ai-tagging` | 2 | Intent scoring (async) |
| `wa-send` | 3 | Dispatch outbound WA messages |
| `broadcast` | 1 | Execute broadcast campaigns |

All jobs carry `businessId` in payload. Workers check conversation status before replying (skip if HUMAN).

## Key Conventions

- **Row-level auth is mandatory.** Never query without scoping to `req.user.businessId`. Return 404 (not 403) for cross-tenant data access attempts.
- **BAILEYS:** One socket per business (~50-80MB RAM each). Cap: `WA_MAX_CONNECTIONS` (default 50). Auto-reconnect with exponential backoff (max 5 attempts). Server startup resets all stale `CONNECTED` credentials to `DISCONNECTED`. Group messages (`@g.us` JIDs) are filtered out in `messages.upsert` handler — only individual chats trigger auto-reply.
- **AI:** Groq SDK. Rate-limited: 3s per lead, 3 consecutive unanswered, 50/day per lead. Falls back: primary model → `GROQ_FALLBACK_MODEL` → hardcoded text.
- **Validation:** Zod schemas co-located with services (not routes). Apply via `validate(schema)` middleware.
- **Auth:** JWT access (15m) + refresh (7d, httpOnly cookie). `JwtPayload = { userId, businessId, role }`. Refresh rotation with stolen-token detection.
- **Logging:** Winston + correlationId (from `x-correlation-id` header or auto-generated UUID). JSON in prod, colorized in dev.

## Non-Obvious

- `.env` must be at **repo root** (loaded by `backend/src/config/env.ts` via `dotenv` from `../../.env`). Not needed inside `backend/`.
- `NODE_OPTIONS="--max-old-space-size=768"` in production Docker (many Baileys connections).
- Backend `dev` script kills port 3000 with `fuser -k 3000/tcp` before starting.
- `prisma migrate dev` is for local dev; `prisma migrate deploy` in CI/CD.
- `docker-compose.dev.yml` uses `network_mode: host` — no port mapping, services connect via localhost.
