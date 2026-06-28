import { useAuthStore } from '../stores/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

// Single in-flight refresh shared across concurrent 401s, so a burst of expired
// requests triggers exactly one refresh instead of a stampede.
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return null;

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) throw new Error('Refresh failed');
        const data = (await res.json()) as {
          accessToken: string;
          refreshToken: string;
        };
        useAuthStore.setState({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        });
        return data.accessToken;
      } catch {
        // Refresh token is invalid/expired — clear the session.
        useAuthStore.getState().logout();
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  return refreshPromise;
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token } = options;

  const doFetch = (authToken?: string | null) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    return fetch(`${API_URL}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  let response = await doFetch(token);

  // If the access token expired, transparently refresh once and retry.
  if (response.status === 401 && token) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await doFetch(newToken);
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || 'Request failed');
  }

  return response.json();
}

// Auth API
export const authApi = {
  register: (email: string, username: string, password: string) =>
    request<{
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string;
        username: string;
        mmr: number;
        league: string;
        createdAt: string;
      };
    }>('/auth/register', {
      method: 'POST',
      body: { email, username, password },
    }),

  login: (email: string, password: string) =>
    request<{
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string;
        username: string;
        mmr: number;
        league: string;
        createdAt: string;
      };
    }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),

  refresh: (refreshToken: string) =>
    request<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    }),
};

// User preferences type
export interface UserPreferences {
  animationSpeed?: number;
  cubeColors?: Record<string, string>;
  ghostOptOut?: boolean;
}

// User profile type
export interface UserProfile {
  id: string;
  username: string;
  mmr: number;
  league: string;
  country?: string;
  createdAt: string;
  stats: Array<{
    id: string;
    puzzleSize: string;
    mmr: number;
    league: string;
    gamesPlayed: number;
    gamesWon: number;
    solvesCompleted: number;
    solvesWon: number;
    bestTimeMs: number | null;
    avgTimeMs: number | null;
    isProvisional: boolean;
  }>;
}

// Users API
export const usersApi = {
  getMe: (token: string) =>
    request<UserProfile>('/users/me', { token }),

  getProfileByUsername: (username: string) =>
    request<UserProfile>(`/users/profile/${username}`),

  updateUsername: (token: string, username: string) =>
    request('/users/me', {
      method: 'PATCH',
      token,
      body: { username },
    }),

  updateCountry: (token: string, country: string) =>
    request<{ country: string }>('/users/me/country', {
      method: 'PUT',
      token,
      body: { country },
    }),

  getPreferences: (token: string) =>
    request<UserPreferences>('/users/me/preferences', { token }),

  updatePreferences: (token: string, preferences: UserPreferences) =>
    request<UserPreferences>('/users/me/preferences', {
      method: 'PUT',
      token,
      body: preferences,
    }),

  getMmrHistory: (userId: string) =>
    request<Array<{ date: string; mmr: number; matchId: string }>>(`/users/${userId}/mmr-history`),

  getUserMatches: (userId: string, page = 1) =>
    request<{
      matches: Array<{
        id: string;
        puzzleSize: string;
        player1: { id: string; username: string };
        player2: { id: string; username: string };
        player1Score: number;
        player2Score: number;
        player1MmrBefore: number;
        player1MmrAfter: number;
        player2MmrBefore: number;
        player2MmrAfter: number;
        winnerId: string;
        status: string;
        createdAt: string;
        endedAt: string;
      }>;
      total: number;
    }>(`/users/${userId}/matches?page=${page}`),

  getGhostRecordingCount: (userId: string) =>
    request<{ count: number }>(`/users/${userId}/ghost-recordings`),

  getAvailableGhostsCount: (token: string, ghostUserId: string, puzzleSize = '3x3') =>
    request<{ count: number }>(`/users/${ghostUserId}/available-ghosts?puzzleSize=${puzzleSize}`, { token }),

  getUserGhostRaces: (userId: string, page = 1) =>
    request<{
      races: Array<{
        id: string;
        type: 'ghost';
        role: 'racer' | 'ghost';
        puzzleSize: string;
        opponent: { id: string; username: string };
        myScore: number;
        opponentScore: number;
        won: boolean;
        mmrBefore: number | null;
        mmrAfter: number | null;
        isOldGhost: boolean;
        createdAt: string;
      }>;
      total: number;
    }>(`/users/${userId}/ghost-races?page=${page}`),
};

// Keybindings API
export const keybindingsApi = {
  getProfiles: (token: string) =>
    request<
      Array<{
        id: string;
        name: string;
        isActive: boolean;
        bindings: Record<string, string>;
      }>
    >('/keybindings', { token }),

  getActive: (token: string) =>
    request<{
      id: string;
      name: string;
      isActive: boolean;
      bindings: Record<string, string>;
    }>('/keybindings/active', { token }),

  updateProfile: (token: string, id: string, updates: { name?: string; bindings?: Record<string, string> }) =>
    request(`/keybindings/${id}`, {
      method: 'PATCH',
      token,
      body: updates,
    }),

  activate: (token: string, id: string) =>
    request(`/keybindings/${id}/activate`, {
      method: 'POST',
      token,
    }),

  reset: (token: string, id: string) =>
    request(`/keybindings/${id}/reset`, {
      method: 'POST',
      token,
    }),
};

// Leaderboard API
export const leaderboardApi = {
  getGlobal: (page = 1, limit = 50) =>
    request<{
      entries: Array<{
        rank: number;
        userId: string;
        username: string;
        mmr: number;
        league: string;
        gamesPlayed: number;
        gamesWon: number;
        winRate: number;
        bestTimeMs: number | null;
      }>;
      total: number;
      page: number;
      pageSize: number;
    }>(`/leaderboard?page=${page}&limit=${limit}`),

  getByPuzzle: (puzzle: string, page = 1, limit = 50) =>
    request<{
      entries: Array<{
        rank: number;
        userId: string;
        username: string;
        mmr: number;
        league: string;
        gamesPlayed: number;
        gamesWon: number;
        winRate: number;
        bestTimeMs: number | null;
      }>;
      total: number;
      page: number;
      pageSize: number;
      puzzleSize: string;
    }>(`/leaderboard/${puzzle}?page=${page}&limit=${limit}`),
};

// Match solve with moves
export interface MatchSolve {
  id: string;
  roundNumber: number;
  scramble: string;
  p1TimeMs: number | null;
  p1MoveCount: number;
  p1Moves: Array<{ seq: number; move: string; clientTs: number; serverTs: number }>;
  p1IsWinner: boolean;
  p1Status: string;
  p2TimeMs: number | null;
  p2MoveCount: number;
  p2Moves: Array<{ seq: number; move: string; clientTs: number; serverTs: number }>;
  p2IsWinner: boolean;
  p2Status: string;
}

// Match detail with solves
export interface MatchDetail {
  id: string;
  puzzleSize: string;
  player1: { id: string; username: string; mmr: number; league: string };
  player2: { id: string; username: string; mmr: number; league: string };
  player1Score: number;
  player2Score: number;
  player1MmrBefore: number;
  player1MmrAfter: number;
  player2MmrBefore: number;
  player2MmrAfter: number;
  winnerId: string;
  status: string;
  createdAt: string;
  startedAt: string;
  endedAt: string;
  solves: MatchSolve[];
}

// Ghost race type
export interface GhostRace {
  id: string;
  type: 'ghost';
  puzzleSize: string;
  ghostUser: { id: string; username: string };
  racerScore: number;
  ghostScore: number;
  racerWon: boolean;
  racerMmrBefore: number;
  racerMmrAfter: number;
  ghostMmrAtRecording: number;
  isOldGhost: boolean;
  createdAt: string;
}

// Matches API
export const matchesApi = {
  getHistory: (token: string, page = 1) =>
    request<{
      matches: Array<{
        id: string;
        puzzleSize: string;
        player1: { id: string; username: string };
        player2: { id: string; username: string };
        player1Score: number;
        player2Score: number;
        winnerId: string;
        status: string;
        createdAt: string;
        endedAt: string;
      }>;
      total: number;
      page: number;
      pageSize: number;
    }>(`/matches?page=${page}`, { token }),

  getMatch: (id: string) =>
    request<MatchDetail>(`/matches/${id}`),

  getGhostRaces: (token: string, page = 1) =>
    request<{
      races: GhostRace[];
      total: number;
      page: number;
      pageSize: number;
    }>(`/matches/ghost-races?page=${page}`, { token }),
};
