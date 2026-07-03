# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Plus2 — a real-time competitive Rubik's cube racing platform. Players race head-to-head
(best-of-5) with live opponent cube visualization, ELO/MMR matchmaking, and leagues.
When no human is available, the ranked flow falls back to **ghost races** (replays of
recorded solves). There are also solo/practice and challenge (private code) modes.

## Monorepo layout

npm workspaces, three packages:

- `packages/shared` — TypeScript types + game constants + pure logic (ELO, leagues,
  badges, scramble lengths). The **socket contract** lives here as `ClientEvents` /
  `ServerEvents` interfaces. Both apps import it as `@plus2/shared`.
- `apps/api` — NestJS backend (REST + Socket.IO). Global route prefix `/api` (except `/health`).
- `apps/web` — Next.js 14 App Router frontend (React 18, TailwindCSS, Zustand, cubing.js).

### Build ordering matters

`@plus2/shared` compiles to `dist/` and **must be built before** the api or web build
will typecheck against it. The root `build` script and Vercel/Docker configs all build
shared first. After editing `packages/shared`, run `npm run build -w packages/shared`
(or `npm run dev -w packages/shared` to watch) or downstream builds use stale types.

## Commands

```bash
npm install                        # also runs patch-package (patches cubing, see patches/)
npm run dev                        # api + web together (concurrently)
npm run dev:api                    # NestJS watch, :3001
npm run dev:web                    # Next.js, :3000
npm run build                      # shared → api → web, in order
npm run lint                       # eslint api + next lint web

# API-scoped (run with -w apps/api)
npm run db:seed                    # seed data (ts-node src/database/seed.ts)
npm run db:reset -w apps/api       # reset DB
npm run migration:run -w apps/api  # run migrations against built dist/
```

There is **no test suite yet** — README's `npm run test` targets don't exist. Verify
changes by running the app.

## Database — reads as Postgres, defaults to SQLite

Despite the README, docker-compose, and `.env.example` all describing PostgreSQL, the
API **defaults to `better-sqlite3`** (a local `plus2.db` file). The choice is `DB_TYPE`
in `app.module.ts` (`sqlite` default; `postgres` otherwise). You do **not** need Docker
running for local dev. Postgres/docker-compose is for the production/AWS path.

- `synchronize: true` in non-production (schema auto-syncs from entities), and
  `migrationsRun: true` always — migrations in `apps/api/src/database/migrations/` run
  on startup. Entities are discovered by the `**/*.entity.ts` glob per module.
- SSL is auto-enabled for any non-localhost Postgres host.

## Real-time architecture — one gateway

`apps/api/src/matchmaking/matchmaking.gateway.ts` (~2600 lines) is a **single monolithic
Socket.IO gateway** on the `/game` namespace that handles *everything* live:
matchmaking queue, live match lifecycle, solo sessions, ghost races, challenges, and
chat. All `@SubscribeMessage` handlers are here. Match state lives in in-memory `Map`s
keyed by `matchId` (storing userIds, not socket refs, so it survives reconnects).

Key gameplay rules baked into the gateway:
- Rotation moves (`x/y/z`) don't start the solve timer; the first face turn does.
- Per-round `playerNDone` flags drop trailing move inputs after a solve is recorded.
- Monotonic clocks are used for duration/anti-cheat math; wall-clock timestamps are the
  shared replay timestamps. Clients periodically emit `clock_sync`.

### Frontend socket layer

One **shared `/game` socket singleton** for the whole app (`apps/web/src/hooks/useSocket.ts`),
stashed on `globalThis` and kept across page navigation — do not create per-page sockets
(it caused disconnect/reconnect churn at match start). Event handlers write into Zustand
stores (`stores/game.ts`, `auth.ts`, `challenge.ts`, `chatroom.ts`, `cubePrefs.ts`), so
they're registered once per socket, not per component. `useSoloSocket` / `useGhostRaceSocket`
are mode-specific wrappers. Cube rendering uses cubing.js `TwistyPlayer` via `TwistyCube.tsx`.

## Conventions & gotchas

- **Puzzle sizes**: `PUZZLE_SIZES` supports 2x2–5x5 and the backend is wired for all of
  them, but the frontend gates play to `AVAILABLE_SIZES = ['3x3']` (a per-page const
  in dashboard/solo/challenge/leaderboard). To enable more, change those consts.
- **Shared logic is the source of truth**: ELO K-factors, league thresholds
  (`getLeagueFromRating`), ghost rating rules, badges (`computeBadges`), and inspection/
  best-of constants all live in `packages/shared/src/index.ts`. Change them there, not in
  a service.
- **Auth**: JWT (access + refresh). Google & WCA OAuth are scaffolded but **inert until
  env creds are set** — routes return `503 not configured`. See `SSO_WCA_SETUP.md`.
  Production bootstrap hard-fails if `JWT_SECRET`/`JWT_REFRESH_SECRET` are unset.
- **Body limit** raised to 3mb in `main.ts` for base64 logo uploads.
- `bugfixes.txt`, `features.txt`, `TODO.md` capture in-flight design intent (e.g. the
  ranked/matchmaking redesign folding ghost mode into "Find Race").

## Deployment

- **Web** → Vercel (`vercel.json`: builds shared + web, output `apps/web/.next`).
- **API** → Docker (`apps/api/Dockerfile`, multi-stage) on AWS ECS/RDS provisioned by
  `terraform/`. `CORS_ORIGIN` is comma-separated; applied to both HTTP and the WS adapter.
