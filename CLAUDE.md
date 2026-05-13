# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Dev: server (tsx watch) + client (Vite) concurrently
npm run dev:server       # Server only: tsx watch server/index.ts on port 3000
npm run dev:client       # Client only: Vite dev server on port 5173
npm run build            # Build both client (Vite) and server (tsc → dist/)
npm run build:client     # vite build → client/dist
npm run build:server     # tsc -p server/tsconfig.json → dist/
npm test                 # vitest run (patterns: server/**/*.test.ts, client/**/*.test.ts)
npm run test:watch       # vitest in watch mode
npm run db:migrate       # Run database migrations (tsx server/scripts/migrate.ts)
npm run db:seed          # Seed database (tsx server/scripts/seed.ts)
npm run db:check-schema  # Verify all SQL uses explicit public. prefix
npm start                # Production start: db:migrate + node dist/server/index.js
```

Quality gate scripts (auth conventions, schema linting):
- `npm run auth:check-conventions`
- `npm run auth:check-client-boundaries`
- `npm run auth:web-smoke`
- `npm run auth:lifecycle-smoke`
- `npm run auth:token-type-smoke`

## Architecture

**Fahem (فاهم)** is a full-stack Arabic competitive trivia game. Monorepo with three source directories:

### `shared/` — Shared types and utilities
- `socketEvents.ts` — All Socket.IO event type contracts (`ServerToClientEvents`, `ClientToServerEvents`, `FahemSocketData`). This is the single source of truth for real-time protocol.
- `socketAcks.ts` / `socketAckErrorCodes.ts` — Standardized ACK types and error code enum.
- `matchReconnectSnapshot.ts` — Zod schemas for reconnect state snapshots (all `.passthrough()` for forward compat).
- `lessonAiPrompt.ts` — AI prompt template builder for custom lesson generation (Arabic). Shared between client and server.
- `lessonJsonParse.ts` — Lenient JSON parsing for LLM-generated lesson content.

### `server/` — Express + Socket.IO backend
- **Entry**: `index.ts` bootstraps Express app → HTTP server → Socket.IO → GameManager → graceful shutdown hooks.
- **Auth**: Firebase Admin SDK as external identity provider behind an `AuthProvider` interface. JWT access/refresh token rotation with SHA-256 hashed refresh tokens in `user_sessions`. CSRF protection for web clients.
- **Middleware**: `optionalAuth` (global, sets `req.auth` if token present), `requireAuth`, `requireRole(roleKey)`. Socket auth via `socketAuth.ts` middleware.
- **Game engine**: `GameManager` (`game/GameManager.ts`, ~1850 lines) owns lobbies, private rooms, active matches, reconnect state. `Match` (`game/Match.ts`, ~2250 lines) runs the game loop. Three modes: `direct`, `study_then_quiz`, `lesson`.
- **Routes**: Auth (`/api/auth/*`), Profile (`/api/profile/*`), Custom Lessons (`/api/custom-lessons/*`), Admin (`/api/admin/*`), Lesson AI Prompt config, User Saved Lessons.
- **Database**: PostgreSQL via `pg.Pool`. All SQL must use explicit `public.` prefix (enforced by `db:check-schema`).
- **Socket handlers**: Lobby (`LobbyCoordinator`), private rooms (`privateRoomSocketHandlers`), reconnect (`ReconnectCoordinator`). All registered in `GameManager.attachSocket()`.
- **Services**: Simple content (AI lesson generation via Gemini/OpenAI), cleanup cron (daily at 3 AM), usage analytics, graceful shutdown orchestration.
- **Runtime**: In-memory runtime stats, structured JSON logging (prefix `[fahem]`), single-node contract (all state in process memory).

### `client/` — Vanilla TypeScript SPA (no framework)
- **Build**: Vite + Tailwind CSS v4 (`@tailwindcss/vite` plugin). Dev server proxies `/api`, `/socket.io`, `/admin` to `127.0.0.1:3000`.
- **Entry**: `src/main.ts` (~239KB) — the entire application core. Contains all state as module-level `let` variables, a monolithic `render()` function that switches on `phase`, all socket event listeners, and all DOM event handlers.
- **Screens**: Extracted screen modules in `src/screens/` (Countdown, LessonDone, LessonReview, Result, SavedLessons, etc.). Each receives a typed deps object rather than importing global state directly.
- **Auth**: `src/auth/` — Firebase Auth SDK + backend session exchange. Auth state stored in an observable store (`authStore.ts`). Access token passed to Socket.IO on connect.
- **Realtime**: `src/realtime/` — Socket.IO client, gameplay event listeners, reconnect logic with exponential backoff, snapshot application.
- **Profile**: `src/profile/` — Editable profile form with country picker, flag icons, birth date selector.
- **Routing**: No router library. Navigation by mutating the `phase` variable and calling `render()`, which destroys and rebuilds the entire `#app` DOM.
- **Styling**: Tailwind utility classes + 39KB custom `style.css`. Arabic (RTL), Tajawal font.

### `db/migrations/` — 63 sequential SQL migration files
Key tables: `questions`, `lessons`, `lesson_categories`, `lesson_sections`, `lesson_items`, `users`, `user_sessions`, `user_profiles`, `user_saved_lessons`, `app_settings`, `simple_content_*`, `game_result_copy`.

## Key conventions

- **Deterministic SQL**: Every table reference must use `public.` prefix. Never rely on `search_path`. Compatible with Neon pooled connections + PgBouncer.
- **Identity model**: Three tiers — `participantId` (game seat), `userId` (stable account UUID), `socket.id` (transport only). Firebase UID is never the internal identity.
- **Auth**: All auth flows go through the `AuthService` / `AuthProvider` interface. Firebase is an implementation detail.
- **Single-node**: All match state lives in process memory. No Redis, no external session store. Graceful shutdown terminates active matches.
- **Reconnect**: After `game_started`, each player gets a `match_resume_token` (32-byte random secret). 20-second grace window for reconnection.
- **Shared types are the contract**: Socket events are typed in `shared/socketEvents.ts`. Both client and server must conform. For forward compatibility, Zod schemas in shared use `.passthrough()`.
- **Arabic-first**: All UI text is hardcoded in Arabic. No i18n library. HTML uses `lang="ar" dir="rtl"`.

## Environment variables

Required: `DATABASE_URL` (PostgreSQL), `CLIENT_ORIGIN`, `AUTH_JWT_SECRET`, Firebase Admin SDK vars (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`), Firebase client vars (`VITE_FIREBASE_API_KEY`, etc.), `AUTH_ADMIN_EMAILS` (comma-separated).

Optional: `NODE_ENV`, `PORT` (default 3000), `FAHEM_SHUTDOWN_BUDGET_MS`, study mode timing vars.
