'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { usersApi, UserProfile } from '@/lib/api';
import { LeagueBadge } from '@/components/LeagueBadge';
import { CountryFlag } from '@/components/CountryFlag';
import type { LeagueTier } from '@plus2/shared';

interface MmrHistoryPoint {
  date: string;
  mmr: number;
  matchId: string;
}

interface MatchHistoryItem {
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
}

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

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [mmrHistory, setMmrHistory] = useState<MmrHistoryPoint[]>([]);
  const [matches, setMatches] = useState<MatchHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadProfile() {
      try {
        setLoading(true);
        setError(null);

        const profileData = await usersApi.getProfileByUsername(username);
        setProfile(profileData);

        // Load MMR history and matches
        const [historyData, matchesData] = await Promise.all([
          usersApi.getMmrHistory(profileData.id),
          usersApi.getUserMatches(profileData.id),
        ]);

        setMmrHistory(historyData);
        setMatches(matchesData.matches);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      } finally {
        setLoading(false);
      }
    }

    if (username) {
      loadProfile();
    }
  }, [username]);

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

  // Calculate totals
  const totalGames = profile.stats.reduce((sum, s) => sum + s.gamesPlayed, 0);
  const totalWins = profile.stats.reduce((sum, s) => sum + s.gamesWon, 0);
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
          <div className="flex items-center gap-4 mb-4">
            <CountryFlag country={profile.country} size="lg" />
            <div>
              <h1 className="text-3xl font-bold">{profile.username}</h1>
              <div className="flex items-center gap-2 mt-1">
                <LeagueBadge league={profile.league as LeagueTier} />
                <span className="text-gray-400">{profile.mmr} MMR</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 text-center">
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
          </div>
        </div>

        {/* Stats by Puzzle */}
        <div className="card mb-6">
          <h2 className="text-xl font-bold mb-4">Stats by Puzzle</h2>
          <div className="grid gap-4">
            {profile.stats.length === 0 ? (
              <p className="text-gray-400">No stats yet</p>
            ) : (
              profile.stats.map((stat) => (
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
          {matches.length === 0 ? (
            <p className="text-gray-400">No matches yet</p>
          ) : (
            <div className="space-y-2">
              {matches.map((match) => {
                const isPlayer1 = match.player1.id === profile.id;
                const opponent = isPlayer1 ? match.player2 : match.player1;
                const myScore = isPlayer1 ? match.player1Score : match.player2Score;
                const oppScore = isPlayer1 ? match.player2Score : match.player1Score;
                const won = match.winnerId === profile.id;
                const mmrBefore = isPlayer1 ? match.player1MmrBefore : match.player2MmrBefore;
                const mmrAfter = isPlayer1 ? match.player1MmrAfter : match.player2MmrAfter;
                const mmrDelta = mmrAfter - mmrBefore;

                return (
                  <div
                    key={match.id}
                    className={`flex items-center justify-between p-3 rounded-lg ${
                      won ? 'bg-green-900/20 border border-green-800/30' : 'bg-red-900/20 border border-red-800/30'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`font-bold ${won ? 'text-green-500' : 'text-red-500'}`}>
                        {won ? 'W' : 'L'}
                      </span>
                      <span className="text-gray-400 text-sm">{match.puzzleSize}</span>
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
                        {formatDate(match.endedAt || match.createdAt)}
                      </span>
                      <Link
                        href={`/match/${match.id}/replay`}
                        className="text-blue-500 hover:text-blue-400 text-sm"
                      >
                        View
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
