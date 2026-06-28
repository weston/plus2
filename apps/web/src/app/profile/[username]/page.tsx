'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { usersApi, UserProfile } from '@/lib/api';
import { LeagueBadge } from '@/components/LeagueBadge';
import { CountryFlag } from '@/components/CountryFlag';
import { useAuthStore } from '@/stores/auth';
import { computeBadges, computeWcaBadges, type WcaPersonalRecords } from '@plus2/shared';
import type { LeagueTier } from '@plus2/shared';

interface MmrHistoryPoint {
  date: string;
  mmr: number;
  matchId: string;
}

interface MatchHistoryItem {
  id: string;
  type: 'pvp';
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
}

interface GhostRaceHistoryItem {
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
}

type HistoryItem = MatchHistoryItem | GhostRaceHistoryItem;

function formatTime(ms: number | null): string {
  if (!ms) return '-';
  const seconds = ms / 1000;
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(2);
    return `${mins}:${secs.padStart(5, '0')}`;
  }
  return seconds.toFixed(2) + 's';
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function MmrChart({ history }: { history: MmrHistoryPoint[] }) {
  if (history.length < 2) {
    return (
      <div className="h-40 flex items-center justify-center text-gray-500">
        Not enough data for graph
      </div>
    );
  }

  const mmrValues = history.map(h => h.mmr);
  const minMmr = Math.min(...mmrValues) - 50;
  const maxMmr = Math.max(...mmrValues) + 50;
  const range = maxMmr - minMmr;

  const width = 100;
  const height = 40;
  const padding = 2;

  const points = history.map((h, i) => {
    const x = padding + (i / (history.length - 1)) * (width - padding * 2);
    const y = height - padding - ((h.mmr - minMmr) / range) * (height - padding * 2);
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="h-40">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full" preserveAspectRatio="none">
        <polyline
          points={points}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>{minMmr.toFixed(0)}</span>
        <span>{maxMmr.toFixed(0)}</span>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const params = useParams();
  const username = params.username as string;
  const { user, accessToken } = useAuthStore();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [mmrHistory, setMmrHistory] = useState<MmrHistoryPoint[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [ghostRecordingCount, setGhostRecordingCount] = useState(0);
  const [availableGhostsCount, setAvailableGhostsCount] = useState(0);
  const [wcaRecords, setWcaRecords] = useState<WcaPersonalRecords | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guard against out-of-order responses overwriting newer state.
    let cancelled = false;

    async function loadProfile() {
      try {
        setLoading(true);
        setError(null);

        const profileData = await usersApi.getProfileByUsername(username);
        if (cancelled) return;
        setProfile(profileData);

        // Pull official WCA records (public API) for WCA badges.
        if (profileData.wcaId) {
          usersApi
            .getWcaRecords(profileData.wcaId)
            .then((r) => {
              if (!cancelled) setWcaRecords(r.personalRecords);
            })
            .catch(() => {});
        } else {
          setWcaRecords(null);
        }

        // Load MMR history, matches, ghost races, and ghost recording count
        const [historyData, matchesData, ghostRacesData, ghostData] = await Promise.all([
          usersApi.getMmrHistory(profileData.id),
          usersApi.getUserMatches(profileData.id),
          usersApi.getUserGhostRaces(profileData.id),
          usersApi.getGhostRecordingCount(profileData.id),
        ]);
        if (cancelled) return;

        setMmrHistory(historyData);
        setGhostRecordingCount(ghostData.count);

        // Combine matches and ghost races, then sort by date
        const pvpMatches: HistoryItem[] = matchesData.matches.map(m => ({ ...m, type: 'pvp' as const }));
        const ghostRaces: HistoryItem[] = ghostRacesData.races.map(r => ({ ...r, type: 'ghost' as const }));
        const combined = [...pvpMatches, ...ghostRaces].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setHistoryItems(combined);

        // If logged in and viewing someone else's profile, check available ghosts
        if (accessToken && user && user.id !== profileData.id) {
          const availableData = await usersApi.getAvailableGhostsCount(accessToken, profileData.id);
          if (cancelled) return;
          setAvailableGhostsCount(availableData.count);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (username) {
      loadProfile();
    }

    return () => {
      cancelled = true;
    };
    // Depend on user.id (not the whole user object) so an MMR/profile update that
    // replaces the user reference doesn't trigger a full refetch.
  }, [username, accessToken, user?.id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading profile...</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error || 'User not found'}</p>
          <Link href="/" className="text-blue-500 hover:underline">
            Go home
          </Link>
        </div>
      </div>
    );
  }

  // Calculate totals (only 3x3 for now)
  const stats3x3 = profile.stats.filter(s => s.puzzleSize === '3x3');
  const totalGames = stats3x3.reduce((sum, s) => sum + s.gamesPlayed, 0);
  const totalWins = stats3x3.reduce((sum, s) => sum + s.gamesWon, 0);
  const winRate = totalGames > 0 ? ((totalWins / totalGames) * 100).toFixed(1) : '0';

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Back link */}
        <Link href="/dashboard" className="text-gray-400 hover:text-white mb-6 inline-block">
          ← Back
        </Link>

        {/* Profile Header */}
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <CountryFlag country={profile.country} size="lg" />
              <div>
                <h1 className="text-3xl font-bold">{profile.username}</h1>
                <div className="flex items-center gap-2 mt-1">
                  <LeagueBadge league={profile.league as LeagueTier} />
                  <span className="text-gray-400">{profile.mmr} MMR</span>
                  {profile.wcaId && (
                    <a
                      href={`https://www.worldcubeassociation.org/persons/${profile.wcaId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
                      title="View WCA profile"
                    >
                      WCA: {profile.wcaId}
                    </a>
                  )}
                </div>
              </div>
            </div>

            {/* Race Against Ghosts Button */}
            {user && user.id !== profile.id && availableGhostsCount > 0 && (
              <Link
                href={`/solo/race?opponent=${profile.id}`}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-lg font-medium transition-all"
              >
                Race Ghost ({availableGhostsCount})
              </Link>
            )}
          </div>

          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold">{totalGames}</p>
              <p className="text-gray-400 text-sm">Games Played</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-500">{totalWins}</p>
              <p className="text-gray-400 text-sm">Wins</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{winRate}%</p>
              <p className="text-gray-400 text-sm">Win Rate</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-orange-500">{ghostRecordingCount}</p>
              <p className="text-gray-400 text-sm">Ghost Recordings</p>
            </div>
          </div>
        </div>

        {/* Badges */}
        {(() => {
          const badges = [
            ...computeBadges({ league: profile.league as LeagueTier, stats: profile.stats }),
            ...computeWcaBadges(wcaRecords),
          ];
          if (badges.length === 0) return null;
          const tierRing: Record<string, string> = {
            bronze: 'ring-amber-700/50',
            silver: 'ring-gray-400/50',
            gold: 'ring-yellow-400/60',
            special: 'ring-purple-400/60',
          };
          return (
            <div className="card mb-6">
              <h2 className="text-xl font-bold mb-4">Badges</h2>
              <div className="flex flex-wrap gap-3">
                {badges.map((b) => (
                  <div
                    key={b.id}
                    title={b.description}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 ring-1 ${tierRing[b.tier] || 'ring-gray-600'}`}
                  >
                    <span className="text-xl leading-none">{b.icon}</span>
                    <span className="text-sm font-medium">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Stats by Puzzle */}
        <div className="card mb-6">
          <h2 className="text-xl font-bold mb-4">Stats by Puzzle</h2>
          <div className="grid gap-4">
            {profile.stats.filter(s => s.puzzleSize === '3x3').length === 0 ? (
              <p className="text-gray-400">No stats yet</p>
            ) : (
              profile.stats
                .filter((stat) => stat.puzzleSize === '3x3')
                .map((stat) => (
                  <div key={stat.id} className="bg-gray-800/50 rounded-lg p-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-lg">{stat.puzzleSize}</span>
                      <div className="flex items-center gap-2">
                        <LeagueBadge league={stat.league as LeagueTier} size="sm" />
                        <span className="text-gray-400">{stat.mmr} MMR</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-sm">
                      <div>
                        <p className="text-gray-400">Games</p>
                        <p>{stat.gamesPlayed}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Wins</p>
                        <p className="text-green-500">{stat.gamesWon}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Best Time</p>
                        <p className="text-yellow-500">{formatTime(stat.bestTimeMs)}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Avg Time</p>
                        <p>{formatTime(stat.avgTimeMs)}</p>
                      </div>
                    </div>
                  </div>
                ))
            )}
            <p className="text-gray-500 text-sm text-center mt-2">
              More puzzle sizes (2x2, 4x4, 5x5) coming soon
            </p>
          </div>
        </div>

        {/* MMR History Chart */}
        <div className="card mb-6">
          <h2 className="text-xl font-bold mb-4">MMR History</h2>
          <MmrChart history={mmrHistory} />
        </div>

        {/* Match History */}
        <div className="card">
          <h2 className="text-xl font-bold mb-4">Match History</h2>
          {historyItems.length === 0 ? (
            <p className="text-gray-400">No matches yet</p>
          ) : (
            <div className="space-y-2">
              {historyItems.map((item) => {
                if (item.type === 'ghost') {
                  // Ghost race
                  const mmrDelta = item.mmrBefore !== null && item.mmrAfter !== null
                    ? item.mmrAfter - item.mmrBefore
                    : null;
                  return (
                    <div
                      key={item.id}
                      className={`flex items-center justify-between p-3 rounded-lg ${
                        item.won ? 'bg-green-900/20 border border-green-800/30' : 'bg-red-900/20 border border-red-800/30'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`font-bold ${item.won ? 'text-green-500' : 'text-red-500'}`}>
                          {item.won ? 'W' : 'L'}
                        </span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          item.role === 'racer'
                            ? 'bg-orange-600/30 text-orange-400'
                            : 'bg-purple-600/30 text-purple-400'
                        }`}>
                          {item.role === 'racer' ? 'vs Ghost' : 'Your Ghost'}
                        </span>
                        <span className="text-gray-400 text-sm">{item.puzzleSize}</span>
                        <span>vs</span>
                        <Link
                          href={`/profile/${item.opponent.username}`}
                          className="text-blue-400 hover:underline"
                        >
                          {item.opponent.username}
                        </Link>
                        {item.isOldGhost && (
                          <span className="text-xs text-gray-500">(old)</span>
                        )}
                      </div>

                      <div className="flex items-center gap-4">
                        <span className="font-mono">
                          {item.myScore} - {item.opponentScore}
                        </span>
                        {mmrDelta !== null ? (
                          <span className={`font-mono ${mmrDelta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            {mmrDelta >= 0 ? '+' : ''}{mmrDelta}
                          </span>
                        ) : (
                          <span className="font-mono text-gray-500">-</span>
                        )}
                        <span className="text-gray-500 text-sm">
                          {formatDate(item.createdAt)}
                        </span>
                      </div>
                    </div>
                  );
                } else {
                  // PvP match
                  const isPlayer1 = item.player1.id === profile.id;
                  const opponent = isPlayer1 ? item.player2 : item.player1;
                  const myScore = isPlayer1 ? item.player1Score : item.player2Score;
                  const oppScore = isPlayer1 ? item.player2Score : item.player1Score;
                  const won = item.winnerId === profile.id;
                  const mmrBefore = isPlayer1 ? item.player1MmrBefore : item.player2MmrBefore;
                  const mmrAfter = isPlayer1 ? item.player1MmrAfter : item.player2MmrAfter;
                  const mmrDelta = mmrAfter - mmrBefore;

                  return (
                    <div
                      key={item.id}
                      className={`flex items-center justify-between p-3 rounded-lg ${
                        won ? 'bg-green-900/20 border border-green-800/30' : 'bg-red-900/20 border border-red-800/30'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`font-bold ${won ? 'text-green-500' : 'text-red-500'}`}>
                          {won ? 'W' : 'L'}
                        </span>
                        <span className="text-gray-400 text-sm">{item.puzzleSize}</span>
                        <span>vs</span>
                        <Link
                          href={`/profile/${opponent.username}`}
                          className="text-blue-400 hover:underline"
                        >
                          {opponent.username}
                        </Link>
                      </div>

                      <div className="flex items-center gap-4">
                        <span className="font-mono">
                          {myScore} - {oppScore}
                        </span>
                        <span className={`font-mono ${mmrDelta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {mmrDelta >= 0 ? '+' : ''}{mmrDelta}
                        </span>
                        <span className="text-gray-500 text-sm">
                          {formatDate(item.endedAt || item.createdAt)}
                        </span>
                        <Link
                          href={`/match/${item.id}/replay`}
                          className="text-blue-500 hover:text-blue-400 text-sm"
                        >
                          View
                        </Link>
                      </div>
                    </div>
                  );
                }
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
