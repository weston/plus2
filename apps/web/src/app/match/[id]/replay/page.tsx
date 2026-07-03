'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { matchesApi, MatchDetail, MatchSolve } from '@/lib/api';
import { TwistyCube } from '@/components/TwistyCube';
import { LeagueBadge } from '@/components/LeagueBadge';
import type { PuzzleSize, LeagueTier } from '@plus2/shared';

type PlaybackMode = 'replay' | 'step';

function formatTime(ms: number | null): string {
  if (ms === null) return 'DNF';
  const seconds = ms / 1000;
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(2);
    return `${mins}:${secs.padStart(5, '0')}`;
  }
  return seconds.toFixed(2) + 's';
}

export default function ReplayPage() {
  const params = useParams();
  const matchId = params.id as string;

  const [match, setMatch] = useState<MatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Playback state
  const [selectedRound, setSelectedRound] = useState(1);
  const [mode, setMode] = useState<PlaybackMode>('replay');
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [p1MoveIndex, setP1MoveIndex] = useState(0);
  const [p2MoveIndex, setP2MoveIndex] = useState(0);

  const playbackRef = useRef<NodeJS.Timeout | null>(null);
  // Playback position in recorded-timeline ms (advanced while playing).
  const playheadRef = useRef(0);

  useEffect(() => {
    async function loadMatch() {
      try {
        setLoading(true);
        const data = await matchesApi.getMatch(matchId);
        setMatch(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load match');
      } finally {
        setLoading(false);
      }
    }
    loadMatch();
  }, [matchId]);

  const currentSolve: MatchSolve | undefined = match?.solves.find(
    (s) => s.roundNumber === selectedRound
  );

  // Get moves up to current index
  const p1Moves = currentSolve?.p1Moves.slice(0, p1MoveIndex).map((m) => m.move) || [];
  const p2Moves = currentSolve?.p2Moves.slice(0, p2MoveIndex).map((m) => m.move) || [];

  const maxP1Moves = currentSolve?.p1Moves.length || 0;
  const maxP2Moves = currentSolve?.p2Moves.length || 0;

  // Reset when round changes
  useEffect(() => {
    setP1MoveIndex(0);
    setP2MoveIndex(0);
    setIsPlaying(false);
    playheadRef.current = 0;
    if (playbackRef.current) {
      clearInterval(playbackRef.current);
    }
  }, [selectedRound]);

  // Recorded timeline: when each move happened, in ms relative to a shared
  // anchor (the round's first recorded move across both players), so the
  // replay plays back with the REAL timing and the two players stay aligned
  // in time — not the old fixed 500ms lockstep, which was neither realtime
  // nor a fair race view.
  const moveTimes = (() => {
    const p1 = currentSolve?.p1Moves || [];
    const p2 = currentSolve?.p2Moves || [];
    const firstAbs = (ms: typeof p1) => {
      const f = ms.find((m) => typeof m.clientTs === 'number' && m.clientTs > 1e10);
      return f ? f.clientTs : null;
    };
    const a1 = firstAbs(p1);
    const a2 = firstAbs(p2);
    const anchor = a1 !== null && a2 !== null ? Math.min(a1, a2) : a1 ?? a2;
    const normalize = (ms: typeof p1) =>
      ms.map((m, i) => {
        const t =
          typeof (m as { tMs?: number }).tMs === 'number'
            ? (m as { tMs?: number }).tMs!
            : typeof m.clientTs === 'number' && m.clientTs <= 1e10
              ? m.clientTs
              : typeof m.clientTs === 'number' && anchor !== null
                ? m.clientTs - anchor
                : i * 500;
        return Number.isFinite(t) ? Math.max(0, t) : i * 500;
      });
    return { p1: normalize(p1), p2: normalize(p2) };
  })();

  // Playback logic: advance the playhead through the recorded timeline.
  useEffect(() => {
    if (!isPlaying || !currentSolve) return;

    let last = Date.now();
    playbackRef.current = setInterval(() => {
      const now = Date.now();
      playheadRef.current += (now - last) * speed;
      last = now;
      const t = playheadRef.current;

      setP1MoveIndex((prev) => {
        let i = prev;
        while (i < maxP1Moves && moveTimes.p1[i] <= t) i++;
        return i;
      });
      setP2MoveIndex((prev) => {
        let i = prev;
        while (i < maxP2Moves && moveTimes.p2[i] <= t) i++;
        return i;
      });
    }, 50);

    return () => {
      if (playbackRef.current) {
        clearInterval(playbackRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, speed, currentSolve, maxP1Moves, maxP2Moves]);

  // Stop when both players are done
  useEffect(() => {
    if (p1MoveIndex >= maxP1Moves && p2MoveIndex >= maxP2Moves && isPlaying) {
      setIsPlaying(false);
    }
  }, [p1MoveIndex, p2MoveIndex, maxP1Moves, maxP2Moves, isPlaying]);

  const handlePlayPause = () => {
    if (p1MoveIndex >= maxP1Moves && p2MoveIndex >= maxP2Moves) {
      // Reset if at end
      setP1MoveIndex(0);
      setP2MoveIndex(0);
      playheadRef.current = 0;
    } else if (!isPlaying) {
      // Resuming (possibly after manual stepping): put the playhead at the
      // last already-shown move so playback continues from here.
      playheadRef.current = Math.max(
        p1MoveIndex > 0 ? moveTimes.p1[p1MoveIndex - 1] : 0,
        p2MoveIndex > 0 ? moveTimes.p2[p2MoveIndex - 1] : 0,
      );
    }
    setIsPlaying(!isPlaying);
  };

  const handleStepForward = () => {
    setP1MoveIndex((prev) => Math.min(prev + 1, maxP1Moves));
    setP2MoveIndex((prev) => Math.min(prev + 1, maxP2Moves));
  };

  const handleStepBackward = () => {
    setP1MoveIndex((prev) => Math.max(prev - 1, 0));
    setP2MoveIndex((prev) => Math.max(prev - 1, 0));
  };

  const handleReset = () => {
    setP1MoveIndex(0);
    setP2MoveIndex(0);
    setIsPlaying(false);
  };

  const handleSkipToEnd = () => {
    setP1MoveIndex(maxP1Moves);
    setP2MoveIndex(maxP2Moves);
    setIsPlaying(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading match...</p>
      </div>
    );
  }

  if (error || !match) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error || 'Match not found'}</p>
          <Link href="/" className="text-blue-500 hover:underline">
            Go home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex justify-between items-center mb-6">
          <Link href="/dashboard" className="text-gray-400 hover:text-white">
            ← Back
          </Link>
          <h1 className="text-2xl font-bold">Match Replay</h1>
          <div className="text-gray-400">
            {match.puzzleSize} | {match.status}
          </div>
        </header>

        {/* Players Info */}
        <div className="card mb-6">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <Link
                href={`/profile/${match.player1.username}`}
                className="font-bold hover:text-blue-400"
              >
                {match.player1.username}
              </Link>
              <LeagueBadge league={match.player1.league as LeagueTier} size="sm" />
            </div>

            <div className="text-center">
              <div className="text-3xl font-bold">
                <span className={match.winnerId === match.player1.id ? 'text-green-500' : ''}>
                  {match.player1Score}
                </span>
                <span className="text-gray-500 mx-3">-</span>
                <span className={match.winnerId === match.player2.id ? 'text-green-500' : ''}>
                  {match.player2Score}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <LeagueBadge league={match.player2.league as LeagueTier} size="sm" />
              <Link
                href={`/profile/${match.player2.username}`}
                className="font-bold hover:text-blue-400"
              >
                {match.player2.username}
              </Link>
            </div>
          </div>
        </div>

        {/* Round Selector */}
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Rounds</h2>
          </div>
          <div className="flex gap-2">
            {match.solves.map((solve) => (
              <button
                key={solve.roundNumber}
                onClick={() => setSelectedRound(solve.roundNumber)}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  selectedRound === solve.roundNumber
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                Round {solve.roundNumber}
                <span className="ml-2 text-xs opacity-75">
                  {solve.p1IsWinner ? 'P1' : solve.p2IsWinner ? 'P2' : '-'}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Scramble */}
        {currentSolve && (
          <div className="card mb-6">
            <p className="text-gray-400 text-sm mb-1">Scramble</p>
            <p className="scramble-text text-lg">{currentSolve.scramble}</p>
          </div>
        )}

        {/* Playback Controls */}
        <div className="card mb-6">
          <div className="flex flex-wrap items-center justify-center gap-4">
            {/* Mode Toggle */}
            <div className="flex rounded-lg overflow-hidden">
              <button
                onClick={() => setMode('replay')}
                className={`px-4 py-2 ${
                  mode === 'replay' ? 'bg-blue-600' : 'bg-gray-800'
                }`}
              >
                Replay
              </button>
              <button
                onClick={() => setMode('step')}
                className={`px-4 py-2 ${
                  mode === 'step' ? 'bg-blue-600' : 'bg-gray-800'
                }`}
              >
                Step
              </button>
            </div>

            {mode === 'replay' && (
              <>
                {/* Play/Pause */}
                <button
                  onClick={handlePlayPause}
                  className="btn btn-primary px-6"
                >
                  {isPlaying ? 'Pause' : 'Play'}
                </button>

                {/* Speed Control */}
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 text-sm">Speed:</span>
                  {[0.25, 0.5, 1, 2].map((s) => (
                    <button
                      key={s}
                      onClick={() => setSpeed(s)}
                      className={`px-2 py-1 rounded text-sm ${
                        speed === s ? 'bg-blue-600' : 'bg-gray-800'
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </>
            )}

            {mode === 'step' && (
              <div className="flex gap-2">
                <button onClick={handleReset} className="btn btn-secondary">
                  Reset
                </button>
                <button onClick={handleStepBackward} className="btn btn-secondary">
                  ← Back
                </button>
                <button onClick={handleStepForward} className="btn btn-secondary">
                  Forward →
                </button>
                <button onClick={handleSkipToEnd} className="btn btn-secondary">
                  End
                </button>
              </div>
            )}
          </div>

          {/* Progress */}
          <div className="mt-4 flex justify-between text-sm text-gray-400">
            <span>
              {match.player1.username}: {p1MoveIndex}/{maxP1Moves} moves
            </span>
            <span>
              {match.player2.username}: {p2MoveIndex}/{maxP2Moves} moves
            </span>
          </div>
        </div>

        {/* Cubes */}
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          {/* Player 1 Cube */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="font-bold">{match.player1.username}</span>
                <LeagueBadge league={match.player1.league as LeagueTier} size="sm" />
              </div>
              <span className={`font-mono ${currentSolve?.p1IsWinner ? 'text-green-500' : ''}`}>
                {formatTime(currentSolve?.p1TimeMs ?? null)}
              </span>
            </div>

            <TwistyCube
              puzzleSize={match.puzzleSize as PuzzleSize}
              scramble={currentSolve?.scramble || ''}
              moves={p1Moves}
              animationSpeed={isPlaying ? 5 : 3}
              faceColors={match.player1.cubeColors}
              logoUrl={match.player1.cubeLogo}
              className="h-64 md:h-80"
            />

            {/* Move List */}
            <div className="mt-4">
              <p className="text-gray-400 text-sm mb-2">Moves ({currentSolve?.p1MoveCount || 0})</p>
              <div className="max-h-24 overflow-y-auto bg-gray-800/50 rounded p-2 text-sm font-mono">
                {currentSolve?.p1Moves.map((m, i) => (
                  <span
                    key={i}
                    className={`inline-block mr-1 ${
                      i < p1MoveIndex ? 'text-white' : 'text-gray-600'
                    }`}
                  >
                    {m.move}
                  </span>
                )) || 'No moves'}
              </div>
            </div>
          </div>

          {/* Player 2 Cube */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="font-bold">{match.player2.username}</span>
                <LeagueBadge league={match.player2.league as LeagueTier} size="sm" />
              </div>
              <span className={`font-mono ${currentSolve?.p2IsWinner ? 'text-green-500' : ''}`}>
                {formatTime(currentSolve?.p2TimeMs ?? null)}
              </span>
            </div>

            <TwistyCube
              puzzleSize={match.puzzleSize as PuzzleSize}
              scramble={currentSolve?.scramble || ''}
              moves={p2Moves}
              animationSpeed={isPlaying ? 5 : 3}
              faceColors={match.player2.cubeColors}
              logoUrl={match.player2.cubeLogo}
              className="h-64 md:h-80"
            />

            {/* Move List */}
            <div className="mt-4">
              <p className="text-gray-400 text-sm mb-2">Moves ({currentSolve?.p2MoveCount || 0})</p>
              <div className="max-h-24 overflow-y-auto bg-gray-800/50 rounded p-2 text-sm font-mono">
                {currentSolve?.p2Moves.map((m, i) => (
                  <span
                    key={i}
                    className={`inline-block mr-1 ${
                      i < p2MoveIndex ? 'text-white' : 'text-gray-600'
                    }`}
                  >
                    {m.move}
                  </span>
                )) || 'No moves'}
              </div>
            </div>
          </div>
        </div>

        {/* All Rounds Summary */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Round Summary</h2>
          <div className="space-y-2">
            {match.solves.map((solve) => (
              <div
                key={solve.roundNumber}
                className="flex justify-between items-center p-3 bg-gray-800/50 rounded-lg"
              >
                <span className="text-gray-400">Round {solve.roundNumber}</span>
                <div className="flex gap-8">
                  <span className={solve.p1IsWinner ? 'text-green-500 font-bold' : ''}>
                    {formatTime(solve.p1TimeMs)}
                  </span>
                  <span className="text-gray-500">vs</span>
                  <span className={solve.p2IsWinner ? 'text-green-500 font-bold' : ''}>
                    {formatTime(solve.p2TimeMs)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
