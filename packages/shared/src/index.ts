// =============================================================================
// ENUMS & CONSTANTS
// =============================================================================

export const PUZZLE_SIZES = ['2x2', '3x3', '4x4', '5x5'] as const;
export type PuzzleSize = (typeof PUZZLE_SIZES)[number];

export const LEAGUE_TIERS = [
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'master',
  'grandmaster',
] as const;
export type LeagueTier = (typeof LEAGUE_TIERS)[number];

export const MATCH_STATUSES = ['pending', 'in_progress', 'completed', 'abandoned', 'forfeited'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const SOLVE_STATUSES = ['pending', 'inspecting', 'solving', 'completed', 'dnf'] as const;
export type SolveStatus = (typeof SOLVE_STATUSES)[number];

// =============================================================================
// LEAGUE THRESHOLDS
// =============================================================================

export const LEAGUE_THRESHOLDS: Record<LeagueTier, number> = {
  bronze: 0,
  silver: 900,
  gold: 1200,
  platinum: 1500,
  diamond: 1800,
  master: 2100,
  grandmaster: 2400,
};

export function getLeagueFromRating(mmr: number): LeagueTier {
  if (mmr >= 2400) return 'grandmaster';
  if (mmr >= 2100) return 'master';
  if (mmr >= 1800) return 'diamond';
  if (mmr >= 1500) return 'platinum';
  if (mmr >= 1200) return 'gold';
  if (mmr >= 900) return 'silver';
  return 'bronze';
}

// =============================================================================
// USER TYPES
// =============================================================================

export interface User {
  id: string;
  email: string;
  username: string;
  mmr: number;
  league: LeagueTier;
  createdAt: string;
}

export interface UserPuzzleStats {
  id: string;
  puzzleSize: PuzzleSize;
  mmr: number;
  league: LeagueTier;
  gamesPlayed: number;
  gamesWon: number;
  solvesCompleted: number;
  solvesWon: number;
  bestTimeMs: number | null;
  avgTimeMs: number | null;
  isProvisional: boolean;
}

export interface PublicProfile {
  id: string;
  username: string;
  mmr: number;
  league: LeagueTier;
  createdAt: string;
  stats: UserPuzzleStats[];
}

// =============================================================================
// KEYBINDINGS
// =============================================================================

export const ALL_MOVES = [
  'R', "R'", 'R2',
  'L', "L'", 'L2',
  'U', "U'", 'U2',
  'D', "D'", 'D2',
  'F', "F'", 'F2',
  'B', "B'", 'B2',
  'M', "M'", 'M2',
  'E', "E'", 'E2',
  'S', "S'", 'S2',
  'x', "x'",
  'y', "y'",
  'z', "z'",
  // Wide moves for 4x4/5x5
  'r', "r'", 'r2',
  'l', "l'", 'l2',
  'u', "u'", 'u2',
  'd', "d'", 'd2',
  'f', "f'", 'f2',
  'b', "b'", 'b2',
] as const;
export type CubeMove = (typeof ALL_MOVES)[number];

export interface KeybindingProfile {
  id: string;
  name: string;
  isActive: boolean;
  bindings: Record<string, string>; // move -> key
}

// Key → Move mapping (allows multiple keys per move)
export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  // Face moves (lowercase)
  'i': 'R', 'k': "R'", '8': 'R2',
  'd': 'L', 'e': "L'", '3': 'L2',
  'j': 'U', 'f': "U'", '7': 'U2',
  's': 'D', 'l': "D'", '2': 'D2',
  'h': 'F', 'g': "F'", '6': 'F2',
  'w': 'B', 'o': "B'", '9': 'B2',
  // Wide moves (uppercase = wide version)
  'I': 'Rw', 'K': "Rw'",
  'D': 'Lw', 'E': "Lw'",
  'J': 'Uw', 'F': "Uw'",
  'S': 'Dw', 'L': "Dw'",
  'H': 'Fw', 'G': "Fw'",
  'W': 'Bw', 'O': "Bw'",
  // Slice moves
  'x': "M'", '4': 'M2',
  // Wide moves
  'r': "Lw'",
  'u': 'Rw',
  'z': 'Dw',
  'c': "Uw'",
  'v': 'Lw',
  // Rotations (multiple keys for same move)
  't': 'x', 'y': 'x',
  'n': "x'", 'b': "x'",
  ';': 'y',
  'a': "y'",
  'q': "z'",
  'p': 'z',
  'm': "Rw'",
  ',': 'Uw',
  '.': "M'",
};

// =============================================================================
// MATCH TYPES
// =============================================================================

export interface Match {
  id: string;
  puzzleSize: PuzzleSize;
  player1Id: string;
  player2Id: string;
  player1Score: number;
  player2Score: number;
  winnerId: string | null;
  status: MatchStatus;
  bestOf: number;
  winsNeeded: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface MatchWithPlayers extends Match {
  player1: Pick<User, 'id' | 'username' | 'mmr' | 'league'>;
  player2: Pick<User, 'id' | 'username' | 'mmr' | 'league'>;
}

export interface SolveRecord {
  id: string;
  matchId: string;
  roundNumber: number;
  scramble: string;
  p1Status: SolveStatus;
  p1TimeMs: number | null;
  p1MoveCount: number;
  p1IsWinner: boolean | null;
  p2Status: SolveStatus;
  p2TimeMs: number | null;
  p2MoveCount: number;
  p2IsWinner: boolean | null;
}

export interface MoveRecord {
  seq: number;
  move: string;
  clientTs: number;
  serverTs?: number;
  tMs?: number; // Relative timestamp from solve start (for batch-submitted moves)
}

// =============================================================================
// WEBSOCKET EVENTS
// =============================================================================

// Client → Server
export interface ClientEvents {
  queue_join: { puzzleSize: PuzzleSize };
  queue_leave: Record<string, never>;
  ready: Record<string, never>;
  // Attach to / detach from the user's live match (match page mount/unmount).
  match_rejoin: Record<string, never>;
  match_leave: Record<string, never>;
  // tMs is relative to the player's solve start (0 during inspection)
  move: { seq: number; move: string; tMs: number };
  solve_complete: { timeMs: number | null };
  rematch: Record<string, never>;
  requeue: Record<string, never>;
}

// Server → Client
export interface ServerEvents {
  queue_joined: { position: number; estimatedWait: number };
  queue_left: Record<string, never>;
  match_found: {
    matchId: string;
    opponent: {
      id: string;
      username: string;
      mmr: number;
      league: LeagueTier;
    };
    puzzleSize: PuzzleSize;
    // Present on reconnect resyncs: the current score from the receiving
    // player's perspective.
    scores?: { you: number; opponent: number };
  };
  round_start: {
    round: number;
    scramble: string;
    inspectionStartsAt: number; // server timestamp
    solveId?: string; // `${matchId}:${round}` — opponent_move events are tagged with this
    inspectionStartServerMs?: number;
    inspectionEndServerMs?: number;
  };
  inspection_end: {
    solveStartsAt: number; // server timestamp
    solveStartServerMs?: number;
    solveId?: string;
  };
  solve_start: {
    solveId: string;
    solveStartServerMs: number;
    inspectionStartServerMs?: number;
    inspectionEndServerMs?: number;
  };
  opponent_solve_start: {
    solveId: string;
    solveStartServerMs: number;
    inspectionStartServerMs?: number;
    inspectionEndServerMs?: number;
  };
  opponent_move: {
    solveId?: string;
    seq: number;
    move: string;
    tMs?: number; // relative to the opponent's solve start
  };
  opponent_ready: Record<string, never>;
  opponent_done: {
    timeMs: number;
  };
  solve_result: {
    round: number;
    yourTime: number | null;
    opponentTime: number | null;
    winner: 'you' | 'opponent' | 'draw' | null;
    scores: { you: number; opponent: number };
  };
  match_end: {
    winner: 'you' | 'opponent';
    finalScores: { you: number; opponent: number };
    mmrDelta: number;
    newMmr: number;
    newLeague: LeagueTier;
  };
  opponent_disconnect: Record<string, never>;
  error: {
    code: string;
    message: string;
  };
}

// =============================================================================
// API TYPES
// =============================================================================

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  mmr: number;
  league: LeagueTier;
  gamesPlayed: number;
  gamesWon: number;
  winRate: number;
  bestTimeMs: number | null;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  total: number;
  page: number;
  pageSize: number;
}

// =============================================================================
// ELO CALCULATIONS
// =============================================================================

export function calculateExpectedScore(playerRating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
}

export function getKFactor(rating: number, isProvisional: boolean): number {
  if (isProvisional) return 64;
  if (rating < 1500) return 32;
  if (rating < 2100) return 24;
  return 16;
}

export function calculateRatingChange(
  playerRating: number,
  opponentRating: number,
  actualScore: number, // 1 = win, 0.5 = draw, 0 = loss
  isProvisional: boolean
): number {
  const expected = calculateExpectedScore(playerRating, opponentRating);
  const k = getKFactor(playerRating, isProvisional);
  return Math.round(k * (actualScore - expected));
}

// Rating change when racing a GHOST. Ghosts are deterministic and re-raceable,
// so they pay out at a reduced rate (live PvP is worth more) and never change the
// ghost owner's rating. The opponent rating is the owner's MMR at recording time.
export const GHOST_K_MULTIPLIER = 0.5;

export function calculateGhostRatingChange(
  racerRating: number,
  ghostRating: number,
  actualScore: number, // 1 = win, 0.5 = draw, 0 = loss
  isProvisional: boolean
): number {
  const expected = calculateExpectedScore(racerRating, ghostRating);
  const k = getKFactor(racerRating, isProvisional) * GHOST_K_MULTIPLIER;
  return Math.round(k * (actualScore - expected));
}

// =============================================================================
// TIMING CONSTANTS
// =============================================================================

export const INSPECTION_DURATION_MS = 15000; // 15 seconds
export const BEST_OF = 5;
export const WINS_NEEDED = 3;
export const MATCHMAKING_INITIAL_RANGE = 100;
export const MATCHMAKING_RANGE_EXPANSION = 50;
export const MATCHMAKING_EXPAND_INTERVAL_MS = 5000;
export const MATCHMAKING_MAX_RANGE = 500;

// Ranked: how long to look for a live human before falling back to a ghost.
export const RANKED_HUMAN_WAIT_MS = 12000;
// Games at the provisional (high-K) rate before a rating settles.
export const PROVISIONAL_GAMES = 10;

// =============================================================================
// SCRAMBLE LENGTHS (based on WCA standards)
// =============================================================================

export const SCRAMBLE_LENGTHS: Record<PuzzleSize, number> = {
  '2x2': 9,
  '3x3': 20,
  '4x4': 44,
  '5x5': 60,
};

// =============================================================================
// SOLO MODE CONSTANTS
// =============================================================================

// Target times in ms for each league (3x3). These represent "ghost" opponent times.
export const SOLO_TARGET_TIMES_3X3: Record<LeagueTier, number> = {
  bronze: 60000,      // 60s
  silver: 40000,      // 40s
  gold: 25000,        // 25s
  platinum: 18000,    // 18s
  diamond: 14000,     // 14s
  master: 11000,      // 11s
  grandmaster: 9000,  // 9s
};

// K-factor multiplier for solo mode (lower than real matches to incentivize PvP)
// Superseded by GHOST_K_MULTIPLIER for ghost races; kept for back-compat.
export const SOLO_K_FACTOR_MULTIPLIER = 0.5;

// Approximate solve-time scaling per puzzle relative to 3x3, used to derive
// synthetic seed-ghost target times for puzzles other than 3x3.
export const PUZZLE_TIME_MULTIPLIER: Record<PuzzleSize, number> = {
  '2x2': 0.35,
  '3x3': 1,
  '4x4': 2.3,
  '5x5': 4.2,
};

// Target time (ms) for a synthetic seed ghost at a given puzzle + league. These
// guarantee there's always an opponent to race, even at zero population.
export function getSeedTargetTime(puzzleSize: PuzzleSize, league: LeagueTier): number {
  return Math.round(SOLO_TARGET_TIMES_3X3[league] * PUZZLE_TIME_MULTIPLIER[puzzleSize]);
}

// Session statuses
export const SOLO_SESSION_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;
export type SoloSessionStatus = (typeof SOLO_SESSION_STATUSES)[number];

// =============================================================================
// BADGES (achievements derived from existing stats — no extra storage)
// =============================================================================

export type BadgeTier = 'bronze' | 'silver' | 'gold' | 'special';

export interface Badge {
  id: string;
  label: string;
  description: string;
  icon: string; // emoji
  tier: BadgeTier;
}

interface BadgeStatLike {
  puzzleSize: string;
  gamesWon: number;
  gamesPlayed: number;
  bestTimeMs: number | null;
}

const LEAGUE_BADGE_ICONS: Record<LeagueTier, string> = {
  bronze: '🥉',
  silver: '🥈',
  gold: '🥇',
  platinum: '💠',
  diamond: '💎',
  master: '👑',
  grandmaster: '🏅',
};

/**
 * Earned badges from a user's standing. Currently just the League badges — the
 * grindy participation/speed badges (first win, sub-N, etc.) were removed in
 * favour of the prestige WCA badges (championships, records, medals).
 * Pure. `stats` is accepted for forward-compat but unused.
 */
export function computeBadges(input: {
  league: LeagueTier;
  stats?: BadgeStatLike[];
}): Badge[] {
  const badges: Badge[] = [];

  // League badges (every tier up to and including the current global league)
  const rank = LEAGUE_TIERS.indexOf(input.league);
  for (let i = 0; i <= rank; i++) {
    const tier = LEAGUE_TIERS[i];
    badges.push({
      id: `league-${tier}`,
      label: `${tier.charAt(0).toUpperCase()}${tier.slice(1)} League`,
      description: `Reached the ${tier} league`,
      icon: LEAGUE_BADGE_ICONS[tier],
      tier: i >= 4 ? 'special' : i >= 2 ? 'gold' : 'silver',
    });
  }

  return badges;
}

// WCA personal records shape (subset) from worldcubeassociation.org/api/v0.
// Times are in CENTISECONDS (e.g. 567 = 5.67s).
export interface WcaPersonalRecords {
  [eventId: string]: {
    single?: { best: number };
    average?: { best: number };
  };
}

/**
 * Best podium/win achievement at WCA *major championships* (World + National),
 * computed server-side from a person's results × the WCA championships table.
 * `bestPos` is the best finishing position (1 = win) across that level's finals;
 * the `*Event` fields name a representative achievement for the badge tooltip.
 */
export interface ChampionshipAchievements {
  world?: { bestPos: number; label: string } | null;
  national?: { bestPos: number; label: string } | null;
}

// Highest WCA record ever held (world > continental > national).
export type WcaRecordTier = 'world' | 'continental' | 'national';

// Championship podiums, best WCA record ever held, and lifetime competition
// medal counts (official 1st/2nd/3rd-place finishes).
export interface WcaAchievements extends ChampionshipAchievements {
  recordTier?: WcaRecordTier | null;
  medals?: { gold: number; silver: number; bronze: number } | null;
}

/**
 * Badges for podiuming / winning a major championship (World or National).
 * A win (pos 1) supersedes a podium at the same level. Pure.
 */
export function computeChampionshipBadges(a: ChampionshipAchievements | null | undefined): Badge[] {
  if (!a) return [];
  const badges: Badge[] = [];

  if (a.world && a.world.bestPos >= 1 && a.world.bestPos <= 3) {
    badges.push(
      a.world.bestPos === 1
        ? { id: 'wc-champion', label: 'World Champion', description: a.world.label || 'Won a WCA World Championship', icon: '👑', tier: 'special' }
        : { id: 'wc-podium', label: 'World Championship Podium', description: a.world.label || 'Podiumed at a WCA World Championship', icon: '🌍', tier: 'special' },
    );
  }

  if (a.national && a.national.bestPos >= 1 && a.national.bestPos <= 3) {
    badges.push(
      a.national.bestPos === 1
        ? { id: 'natl-champion', label: 'National Champion', description: a.national.label || 'Won a National Championship', icon: '🏆', tier: 'gold' }
        : { id: 'natl-podium', label: 'National Championship Podium', description: a.national.label || 'Podiumed at a National Championship', icon: '🥉', tier: 'gold' },
    );
  }

  return badges;
}

/** Badge for the highest WCA record (single or average) a person has ever held. Pure. */
export function computeRecordBadge(tier: WcaRecordTier | null | undefined): Badge[] {
  switch (tier) {
    case 'world':
      return [{ id: 'wca-wr', label: 'World Record', description: 'Has held a WCA World Record', icon: '🌍', tier: 'special' }];
    case 'continental':
      return [{ id: 'wca-cr', label: 'Continental Record', description: 'Has held a WCA Continental Record', icon: '🗺️', tier: 'special' }];
    case 'national':
      return [{ id: 'wca-nr', label: 'National Record', description: 'Has held a WCA National Record', icon: '⚡', tier: 'gold' }];
    default:
      return [];
  }
}
