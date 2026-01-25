'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { leaderboardApi } from '@/lib/api';
import { LeagueBadge } from '@/components/LeagueBadge';
import type { PuzzleSize, LeagueTier } from '@plus2/shared';

const PUZZLE_SIZES: (PuzzleSize | 'global')[] = ['global', '2x2', '3x3', '4x4', '5x5'];

interface LeaderboardEntry {
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

export default function LeaderboardPage() {
  const [selectedPuzzle, setSelectedPuzzle] = useState<PuzzleSize | 'global'>('global');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    setIsLoading(true);

    const fetchData = selectedPuzzle === 'global'
      ? leaderboardApi.getGlobal(page)
      : leaderboardApi.getByPuzzle(selectedPuzzle, page);

    fetchData
      .then((data) => {
        setEntries(data.entries as LeaderboardEntry[]);
        setTotal(data.total);
      })
      .finally(() => setIsLoading(false));
  }, [selectedPuzzle, page]);

  const formatTime = (ms: number | null) => {
    if (!ms) return '-';
    return `${(ms / 1000).toFixed(2)}s`;
  };

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="text-gray-400 hover:text-white">
              ← Back
            </Link>
            <h1 className="text-2xl font-bold">Leaderboard</h1>
          </div>
        </header>

        {/* Puzzle Filter */}
        <div className="flex gap-2 mb-6">
          {PUZZLE_SIZES.map((size) => (
            <button
              key={size}
              onClick={() => {
                setSelectedPuzzle(size);
                setPage(1);
              }}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${
                selectedPuzzle === size
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {size === 'global' ? 'Global' : size}
            </button>
          ))}
        </div>

        {/* Leaderboard Table */}
        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-gray-400">Loading...</div>
          ) : entries.length === 0 ? (
            <div className="p-8 text-center text-gray-400">No players yet</div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-800/50">
                <tr>
                  <th className="text-left p-4 font-semibold">Rank</th>
                  <th className="text-left p-4 font-semibold">Player</th>
                  <th className="text-left p-4 font-semibold">League</th>
                  <th className="text-right p-4 font-semibold">MMR</th>
                  <th className="text-right p-4 font-semibold">Games</th>
                  <th className="text-right p-4 font-semibold">Win Rate</th>
                  <th className="text-right p-4 font-semibold">Best Time</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.userId}
                    className="border-t border-gray-800 hover:bg-gray-800/30"
                  >
                    <td className="p-4">
                      <span
                        className={`font-bold ${
                          entry.rank === 1
                            ? 'text-yellow-500'
                            : entry.rank === 2
                              ? 'text-gray-300'
                              : entry.rank === 3
                                ? 'text-amber-700'
                                : ''
                        }`}
                      >
                        #{entry.rank}
                      </span>
                    </td>
                    <td className="p-4">
                      <Link
                        href={`/profile/${entry.userId}`}
                        className="hover:text-blue-500"
                      >
                        {entry.username}
                      </Link>
                    </td>
                    <td className="p-4">
                      <LeagueBadge league={entry.league} size="sm" />
                    </td>
                    <td className="p-4 text-right font-mono">{entry.mmr}</td>
                    <td className="p-4 text-right">{entry.gamesPlayed}</td>
                    <td className="p-4 text-right">
                      {(entry.winRate * 100).toFixed(1)}%
                    </td>
                    <td className="p-4 text-right font-mono">
                      {formatTime(entry.bestTimeMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {total > 50 && (
          <div className="flex justify-center gap-2 mt-6">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="btn btn-secondary disabled:opacity-50"
            >
              Previous
            </button>
            <span className="px-4 py-2 text-gray-400">
              Page {page} of {Math.ceil(total / 50)}
            </span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={page >= Math.ceil(total / 50)}
              className="btn btn-secondary disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
