const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

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
};
