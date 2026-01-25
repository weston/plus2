# Plus2 - Competitive Rubik's Cube Racing Platform

A real-time competitive Rubik's cube racing platform with matchmaking, ELO/MMR rankings, leagues, and live opponent visualization.

## Features

- **Real-time Racing**: Race against opponents with live cube visualization
- **Matchmaking**: ELO-based matchmaking pairs you with similar-skill players
- **Multiple Puzzle Sizes**: Support for 2x2, 3x3, 4x4, and 5x5 cubes
- **Ranked Leagues**: Climb from Bronze to Grandmaster
- **Custom Keybindings**: Configure controls to match your solving style
- **Best-of-5 Matches**: First to win 3 solves takes the match

## Tech Stack

- **Frontend**: Next.js 14, React 18, TailwindCSS, Zustand
- **Backend**: NestJS, TypeORM, Socket.IO
- **Database**: PostgreSQL
- **Cube Rendering**: cubing.js (TwistyPlayer)

## Quick Start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose (for PostgreSQL)
- npm or yarn

### 1. Clone and Install

```bash
cd plus2
npm install
```

### 2. Start Database

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379 (optional, for future scaling)

### 3. Configure Environment

```bash
# API configuration
cp apps/api/.env.example apps/api/.env

# Web configuration
cp apps/web/.env.local.example apps/web/.env.local
```

Edit `apps/api/.env` if needed (defaults work for local development).

### 4. Build Shared Package

```bash
npm run build -w packages/shared
```

### 5. Start Development Servers

```bash
# In one terminal - start API
npm run dev:api

# In another terminal - start web
npm run dev:web
```

Or run both together:

```bash
npm run dev
```

### 6. Access the App

- **Web App**: http://localhost:3000
- **API**: http://localhost:3001

## Project Structure

```
plus2/
├── apps/
│   ├── api/                 # NestJS backend
│   │   ├── src/
│   │   │   ├── auth/        # Authentication (JWT)
│   │   │   ├── users/       # User profiles & stats
│   │   │   ├── keybindings/ # Keybinding profiles
│   │   │   ├── matchmaking/ # Queue & WebSocket gateway
│   │   │   ├── matches/     # Match & solve management
│   │   │   └── leaderboard/ # Rankings
│   │   └── .env.example
│   └── web/                 # Next.js frontend
│       ├── src/
│       │   ├── app/         # Pages (App Router)
│       │   ├── components/  # React components
│       │   ├── hooks/       # Custom hooks
│       │   ├── lib/         # API client
│       │   └── stores/      # Zustand stores
│       └── .env.local.example
├── packages/
│   └── shared/              # Shared types & utilities
├── docker-compose.yml       # Database services
└── package.json             # Workspace root
```

## API Endpoints

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Login |
| POST | /api/auth/refresh | Refresh token |
| GET | /api/users/me | Get current user |
| PATCH | /api/users/me | Update username |
| GET | /api/keybindings | Get keybinding profiles |
| GET | /api/keybindings/active | Get active profile |
| PATCH | /api/keybindings/:id | Update profile |
| POST | /api/keybindings/:id/activate | Set active profile |
| GET | /api/leaderboard | Global leaderboard |
| GET | /api/leaderboard/:puzzle | Puzzle leaderboard |
| GET | /api/matches | Match history |
| GET | /api/matches/:id | Match details |

### WebSocket Events (namespace: /game)

#### Client → Server
- `queue_join` - Join matchmaking queue
- `queue_leave` - Leave queue
- `ready` - Ready for next round
- `move` - Send cube move
- `solve_complete` - Signal solve completion
- `rematch` / `requeue` - After match ends

#### Server → Client
- `queue_joined` - Confirmed in queue
- `match_found` - Match created
- `round_start` - New round with scramble
- `inspection_end` - Solve timer starts
- `opponent_move` - Opponent made a move
- `opponent_done` - Opponent finished
- `solve_result` - Round results
- `match_end` - Final results + MMR change

## ELO Rating System

```
Rating Change = K × (Actual - Expected)

Expected Score = 1 / (1 + 10^((OpponentRating - YourRating) / 400))

K-Factor:
- Provisional (< 10 games): 64
- Bronze-Gold (< 1500): 32
- Platinum-Diamond (< 2100): 24
- Master+ (≥ 2100): 16

League Thresholds:
- Bronze: 0-899
- Silver: 900-1199
- Gold: 1200-1499
- Platinum: 1500-1799
- Diamond: 1800-2099
- Master: 2100-2399
- Grandmaster: 2400+
```

## Keybindings

Default keybindings (csTimer-style):

| Move | Key | Move | Key |
|------|-----|------|-----|
| R | i | R' | k |
| L | d | L' | e |
| U | j | U' | f |
| D | s | D' | l |
| F | h | F' | g |
| B | w | B' | o |
| M | v | M' | r |
| x | t | x' | b |
| y | a | y' | ; |
| z | p | z' | q |

## MVP Acceptance Tests

### Account Flow
- [ ] Register new account
- [ ] Login with credentials
- [ ] View profile with stats
- [ ] Logout and re-login

### Matchmaking
- [ ] Select puzzle size (2x2-5x5)
- [ ] Join matchmaking queue
- [ ] See queue position
- [ ] Cancel queue
- [ ] Get matched with opponent

### Match Flow
- [ ] See scramble for round
- [ ] 15-second inspection countdown
- [ ] Timer starts on first move (or after inspection)
- [ ] Make moves with keybindings
- [ ] See own cube update
- [ ] See opponent's cube update in real-time
- [ ] Complete solve (press Space)
- [ ] See round results
- [ ] Play best-of-5 rounds
- [ ] See match results with MMR change

### Settings
- [ ] View current keybindings
- [ ] Change keybinding for a move
- [ ] Detect key conflicts
- [ ] Save keybindings
- [ ] Reset to defaults

### Leaderboard
- [ ] View global leaderboard
- [ ] View per-puzzle leaderboard
- [ ] See ranks, MMR, win rates

## Phase 2 Roadmap

- [ ] **Anti-cheat**: Server-side move validation, timing verification
- [ ] **Seasons**: Ranked seasons with resets, rewards
- [ ] **OAuth**: Google/Discord login
- [ ] **Spectating**: Watch live matches
- [ ] **Replays**: View past matches move-by-move
- [ ] **Friends**: Add friends, challenge directly
- [ ] **Practice Mode**: Solo scrambles with timing
- [ ] **Mobile**: Responsive design, touch controls
- [ ] **Redis Integration**: Horizontal scaling for matchmaking

## Development

### Database Schema

See `apps/api/src/database/` or the SQL schema in the architecture docs.

### Adding a New Puzzle Size

1. Add to `PUZZLE_SIZES` in `packages/shared/src/index.ts`
2. Add scramble length to `SCRAMBLE_LENGTHS`
3. Database will auto-create stats for new puzzle on user signup

### Running Tests

```bash
# API tests (when added)
npm run test -w apps/api

# E2E tests (when added)
npm run test:e2e
```

## License

MIT
