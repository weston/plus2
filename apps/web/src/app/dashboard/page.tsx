'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import { useSocket } from '@/hooks/useSocket';
import { LeagueBadge } from '@/components/LeagueBadge';
import { usersApi } from '@/lib/api';
import type { PuzzleSize, LeagueTier } from '@plus2/shared';

const PUZZLE_SIZES: PuzzleSize[] = ['2x2', '3x3', '4x4', '5x5'];
const AVAILABLE_SIZES: PuzzleSize[] = ['3x3']; // Only 3x3 is available for now

interface Stats {
  puzzleSize: PuzzleSize;
  mmr: number;
  league: LeagueTier;
  gamesPlayed: number;
  gamesWon: number;
  bestTimeMs: number | null;
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, accessToken, logout, _hasHydrated } = useAuthStore();
  const { phase, puzzleSize, setPuzzleSize, queuePosition, estimatedWait } = useGameStore();
  const { joinQueue, leaveQueue } = useSocket();
  const [stats, setStats] = useState<Stats[]>([]);
  const [selectedSize, setSelectedSize] = useState<PuzzleSize>('3x3');

  // Redirect if not logged in (wait for hydration first)
  useEffect(() => {
    if (_hasHydrated && (!user || !accessToken)) {
      router.push('/login');
    }
  }, [user, accessToken, router, _hasHydrated]);

  // Load user stats
  useEffect(() => {
    if (!accessToken) return;

    usersApi.getMe(accessToken).then((data) => {
      setStats(data.stats as Stats[]);
    });
  }, [accessToken]);

  // Redirect to match when found
  useEffect(() => {
    if (phase === 'matched') {
      router.push('/match');
    }
  }, [phase, router]);

  const handleQueue = () => {
    if (phase === 'queuing') {
      leaveQueue();
    } else {
      setPuzzleSize(selectedSize);
      joinQueue(selectedSize);
    }
  };

  const handleLogout = () => {
    logout();
    router.push('/');
  };

  if (!user) return null;

  const currentStats = stats.find((s) => s.puzzleSize === selectedSize);

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex justify-between items-center mb-8">
          <Link href="/" className="text-2xl font-bold">
            <span className="text-blue-500">Plus</span>
            <span className="text-yellow-500">2</span>
          </Link>

          <div className="flex items-center gap-4">
            <Link href="/practice" className="text-gray-400 hover:text-white">
              Practice
            </Link>
            <Link href="/leaderboard" className="text-gray-400 hover:text-white">
              Leaderboard
            </Link>
            <Link href="/settings" className="text-gray-400 hover:text-white">
              Settings
            </Link>
            <button onClick={handleLogout} className="text-gray-400 hover:text-white">
              Logout
            </button>
          </div>
        </header>

        {/* User Info */}
        <div className="card mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-gray-700 flex items-center justify-center text-2xl font-bold">
                {user.username[0].toUpperCase()}
              </div>
              <div>
                <h2 className="text-2xl font-bold">{user.username}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <LeagueBadge league={user.league} />
                  <span className="text-gray-400">{user.mmr} MMR</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Queue Section */}
        <div className="grid md:grid-cols-2 gap-8">
          {/* Puzzle Selection */}
          <div className="card">
            <h3 className="text-xl font-semibold mb-4">Select Puzzle</h3>

            <div className="grid grid-cols-2 gap-3 mb-6">
              {PUZZLE_SIZES.map((size) => {
                const isAvailable = AVAILABLE_SIZES.includes(size);
                return (
                  <button
                    key={size}
                    onClick={() => isAvailable && setSelectedSize(size)}
                    disabled={phase === 'queuing' || !isAvailable}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      selectedSize === size && isAvailable
                        ? 'border-blue-500 bg-blue-500/20'
                        : isAvailable
                        ? 'border-gray-700 hover:border-gray-600'
                        : 'border-gray-800 opacity-50 cursor-not-allowed'
                    } ${phase === 'queuing' ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <div className="text-2xl font-bold">{size}</div>
                    <div className="text-sm text-gray-400">
                      {isAvailable
                        ? `${stats.find((s) => s.puzzleSize === size)?.gamesPlayed || 0} games`
                        : 'Coming Soon'}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleQueue}
                className={`flex-1 py-4 rounded-lg font-bold text-lg transition-all ${
                  phase === 'queuing'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-green-600 hover:bg-green-700'
                }`}
              >
                {phase === 'queuing' ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="animate-spin">◌</span>
                    Cancel ({estimatedWait}s)
                  </span>
                ) : (
                  'Find Match'
                )}
              </button>

              <Link
                href="/practice"
                className="flex-1 py-4 rounded-lg font-bold text-lg text-center bg-blue-600 hover:bg-blue-700 transition-all"
              >
                Practice
              </Link>
            </div>
          </div>

          {/* Stats for Selected Puzzle */}
          <div className="card">
            <h3 className="text-xl font-semibold mb-4">{selectedSize} Stats</h3>

            {currentStats ? (
              <div className="space-y-4">
                <div className="flex justify-between">
                  <span className="text-gray-400">Rating</span>
                  <span className="font-bold">{currentStats.mmr} MMR</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">League</span>
                  <LeagueBadge league={currentStats.league} size="sm" />
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Games Played</span>
                  <span>{currentStats.gamesPlayed}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Win Rate</span>
                  <span>
                    {currentStats.gamesPlayed > 0
                      ? ((currentStats.gamesWon / currentStats.gamesPlayed) * 100).toFixed(1)
                      : 0}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Best Time</span>
                  <span className="font-mono">
                    {currentStats.bestTimeMs
                      ? `${(currentStats.bestTimeMs / 1000).toFixed(2)}s`
                      : '-'}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-gray-400">No games played yet</p>
            )}
          </div>
        </div>

        {/* Recent Matches */}
        <div className="card mt-8">
          <h3 className="text-xl font-semibold mb-4">Recent Matches</h3>
          <p className="text-gray-400">Match history will appear here</p>
        </div>
      </div>
    </div>
  );
}
