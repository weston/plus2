'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import { useChatStore } from '@/stores/chatroom';
import { useCubePrefs } from '@/stores/cubePrefs';
import { useSocket } from '@/hooks/useSocket';
import { CountryFlag } from '@/components/CountryFlag';
import { LeagueBadge } from '@/components/LeagueBadge';
import { usersApi, matchesApi, GhostRace } from '@/lib/api';
import { RANKED_HUMAN_WAIT_MS } from '@plus2/shared';
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

// Global chat room: everyone can read, WCA-verified accounts can send.
function GlobalChat() {
  const { joinChat, leaveChat, sendChat } = useSocket();
  const { joined, canSend, messages } = useChatStore();
  const { user } = useAuthStore();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    joinChat();
    return () => leaveChat();
  }, [joinChat, leaveChat]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    sendChat(text);
    setDraft('');
  };

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="card mt-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xl font-semibold">Global Chat</h3>
        <span className="text-xs text-gray-500">WCA-verified accounts can chat</span>
      </div>

      <div ref={listRef} className="h-64 overflow-y-auto space-y-1.5 pr-1 mb-3">
        {!joined && <p className="text-gray-500 text-sm">Connecting…</p>}
        {joined && messages.length === 0 && (
          <p className="text-gray-500 text-sm">No messages yet — say hi!</p>
        )}
        {messages.map((m, i) => (
          <div key={m.id || i} className="text-sm leading-snug">
            <span className="text-gray-500 text-xs mr-2">{fmtTime(m.ts)}</span>
            {m.country && <CountryFlag country={m.country} size="sm" />}
            <Link
              href={`/profile/${m.username}`}
              className={`font-medium mx-1 hover:underline ${m.userId === user?.id ? 'text-blue-400' : 'text-gray-200'}`}
            >
              {m.username}
            </Link>
            <span className="text-gray-300 break-words">{m.text}</span>
          </div>
        ))}
      </div>

      {canSend ? (
        <form onSubmit={submit} className="flex gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={280}
            placeholder="Message the community…"
            className="input flex-1 text-sm"
          />
          <button type="submit" disabled={!draft.trim()} className="btn btn-primary px-4 disabled:opacity-50">
            Send
          </button>
        </form>
      ) : (
        <div className="text-sm text-gray-400 border border-gray-700 rounded-lg px-3 py-2">
          <Link href="/settings" className="text-blue-400 hover:underline">
            Link your WCA account
          </Link>{' '}
          to chat with the community.
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, accessToken, logout, _hasHydrated } = useAuthStore();
  const { phase, puzzleSize, setPuzzleSize, queuePosition, estimatedWait } = useGameStore();
  const { joinQueue, leaveQueue } = useSocket();
  const [stats, setStats] = useState<Stats[]>([]);
  const [selectedSize, setSelectedSize] = useState<PuzzleSize>('3x3');
  const [ghostRaces, setGhostRaces] = useState<GhostRace[]>([]);

  // Redirect if not logged in (wait for hydration first)
  useEffect(() => {
    if (_hasHydrated && (!user || !accessToken)) {
      router.push('/login');
    }
  }, [user, accessToken, router, _hasHydrated]);

  // Load user stats and ghost races
  useEffect(() => {
    if (!accessToken) return;

    usersApi.getMe(accessToken).then((data) => {
      setStats(data.stats as Stats[]);
    }).catch(() => {
      // Leave stats empty on failure rather than throwing an unhandled rejection
      setStats([]);
    });

    matchesApi.getGhostRaces(accessToken).then((data) => {
      setGhostRaces(data.races);
    }).catch(() => {
      // Ghost races API might not be available
      setGhostRaces([]);
    });

    // Hydrate the local cube-color theme from the server copy (covers a
    // fresh browser with empty localStorage).
    usersApi.getPreferences(accessToken).then((prefs) => {
      if (prefs.cubeColors) useCubePrefs.getState().setColors(prefs.cubeColors);
    }).catch(() => {});
  }, [accessToken]);

  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFallback = () => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  // Redirect to the live match when a human is found.
  useEffect(() => {
    if (phase === 'matched') {
      clearFallback();
      router.push('/match');
    }
  }, [phase, router]);

  // Clear the fallback timer on unmount.
  useEffect(() => () => clearFallback(), []);

  // The socket now survives navigation, so leaving the dashboard no longer
  // implicitly leaves the queue via a disconnect — do it explicitly. (Leaving
  // because a match was found is fine: phase is 'matched' by then.)
  useEffect(() => {
    return () => {
      if (useGameStore.getState().phase === 'queuing') {
        leaveQueue();
      }
    };
  }, [leaveQueue]);

  // One "Find Race": look for a live human, then fall back to a ghost so there's
  // always an opponent.
  const handleFindRace = () => {
    if (phase === 'queuing') {
      clearFallback();
      leaveQueue();
      return;
    }
    setPuzzleSize(selectedSize);
    joinQueue(selectedSize);
    clearFallback();
    fallbackTimerRef.current = setTimeout(() => {
      // No human in time → race a ghost. The ghost page seed-falls-back, so this
      // always lands an opponent.
      if (useGameStore.getState().phase === 'queuing') {
        leaveQueue();
        router.push(`/solo/race?auto=1&size=${selectedSize}`);
      }
    }, RANKED_HUMAN_WAIT_MS);
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
            <Link href={`/profile/${user.username}`} className="text-gray-400 hover:text-white">
              Profile
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
                onClick={handleFindRace}
                className={`flex-1 py-4 rounded-lg font-bold text-lg transition-all ${
                  phase === 'queuing'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-green-600 hover:bg-green-700'
                }`}
              >
                {phase === 'queuing' ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="animate-spin">&#9696;</span>
                    Finding opponent... (Cancel)
                  </span>
                ) : (
                  'Find Race'
                )}
              </button>

              <Link
                href="/challenge"
                className="flex-1 py-4 rounded-lg font-bold text-lg text-center bg-purple-600 hover:bg-purple-700 transition-all"
              >
                Challenge
              </Link>
            </div>

            {/* Ghost creation is folded into racing now: every race you play
                automatically records a ghost for others. The dedicated Ghost
                Mode pages still exist (linked from profiles) but aren't a
                primary destination anymore. */}
            <div className="flex gap-3 mt-3">
              <Link
                href="/practice"
                className="flex-1 py-3 rounded-lg font-medium text-center bg-gray-700 hover:bg-gray-600 transition-all"
              >
                Zen Mode
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
          {ghostRaces.length > 0 ? (
            <div className="space-y-3">
              {ghostRaces.slice(0, 5).map((race) => {
                const mmrChange = race.racerMmrAfter - race.racerMmrBefore;
                return (
                  <div
                    key={race.id}
                    className={`p-3 rounded-lg border ${
                      race.racerWon
                        ? 'border-green-500/30 bg-green-500/10'
                        : 'border-red-500/30 bg-red-500/10'
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-3">
                        <span className="text-xs px-2 py-0.5 rounded bg-orange-600/30 text-orange-400">
                          Ghost
                        </span>
                        <span className="text-sm text-gray-400">{race.puzzleSize}</span>
                        <span className="font-medium">
                          vs {race.ghostUser.username}
                          {race.isOldGhost && (
                            <span className="text-xs text-gray-500 ml-1">(old ghost)</span>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="font-mono">
                          {race.racerScore} - {race.ghostScore}
                        </span>
                        <span
                          className={`font-mono text-sm ${
                            mmrChange >= 0 ? 'text-green-400' : 'text-red-400'
                          }`}
                        >
                          {mmrChange >= 0 ? '+' : ''}{mmrChange} MMR
                        </span>
                        <span className="text-sm text-gray-500">
                          {new Date(race.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-gray-400">No matches yet. Play some ghost races to see them here!</p>
          )}
        </div>

        {/* Global Chat */}
        <GlobalChat />
      </div>
    </div>
  );
}
