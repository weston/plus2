'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { useSoloSocket } from '@/hooks/useSoloSocket';
import { useKeybindings } from '@/hooks/useKeybindings';
import { TwistyCube, TwistyCubeHandle } from '@/components/TwistyCube';
import type { PuzzleSize } from '@plus2/shared';

const PUZZLE_SIZES: PuzzleSize[] = ['2x2', '3x3', '4x4', '5x5'];
const AVAILABLE_SIZES: PuzzleSize[] = ['3x3'];

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

export default function SoloPage() {
  const router = useRouter();
  const { user, accessToken, _hasHydrated } = useAuthStore();
  const solo = useSoloSocket();

  const [selectedSize, setSelectedSize] = useState<PuzzleSize>('3x3');
  const [inspectionTime, setInspectionTime] = useState(15);
  const [solveTime, setSolveTime] = useState(0);
  const [moveSeq, setMoveSeq] = useState(0);
  const [moves, setMoves] = useState<string[]>([]);
  const [isSolving, setIsSolving] = useState(false); // Local state: user started solving
  const moveSeqRef = useRef(0);
  // Track moves with timestamps for batch submission
  const recordedMovesRef = useRef<Array<{ seq: number; move: string; tMs: number }>>([]);

  const timerRef = useRef<number | null>(null);
  const solveStartTimeRef = useRef(0);
  const cubeRef = useRef<TwistyCubeHandle>(null);
  const isSolvedRef = useRef(false);

  // Redirect if not logged in
  useEffect(() => {
    if (_hasHydrated && (!user || !accessToken)) {
      router.push('/login');
    }
  }, [user, accessToken, router, _hasHydrated]);

  // Handle inspection countdown and reset state for new round
  useEffect(() => {
    if (solo.phase === 'inspecting' && solo.inspectionStartsAt > 0) {
      // Reset state for new round
      setMoves([]);
      moveSeqRef.current = 0;
      setMoveSeq(0);
      setSolveTime(0);
      setIsSolving(false);
      isSolvedRef.current = false;
      recordedMovesRef.current = []; // Clear recorded moves for new round
      if (timerRef.current) {
        cancelAnimationFrame(timerRef.current);
        timerRef.current = null;
      }

      const updateInspection = () => {
        const now = Date.now();
        const elapsed = now - solo.inspectionStartsAt;
        const remaining = Math.max(0, Math.ceil((15000 - elapsed) / 1000));
        setInspectionTime(remaining);
      };

      updateInspection();
      const interval = setInterval(updateInspection, 100);

      return () => clearInterval(interval);
    }
  }, [solo.phase, solo.inspectionStartsAt]);

  // Handle solve timer - only start if user didn't already start during inspection
  useEffect(() => {
    if (solo.phase === 'solving' && solo.solveStartsAt > 0) {
      setInspectionTime(0);
      isSolvedRef.current = false;

      // Only start timer if user didn't already start during inspection
      if (!timerRef.current) {
        solveStartTimeRef.current = solo.solveStartsAt;
        setMoves([]);
        moveSeqRef.current = 0;
        setMoveSeq(0);

        let lastUpdate = 0;
        const updateTimer = (timestamp: number) => {
          if (timestamp - lastUpdate >= 16) {
            const elapsed = Date.now() - solo.solveStartsAt;
            setSolveTime(elapsed);
            lastUpdate = timestamp;
          }
          timerRef.current = requestAnimationFrame(updateTimer);
        };
        timerRef.current = requestAnimationFrame(updateTimer);
      }
    }
  }, [solo.phase, solo.solveStartsAt]);

  // Check if move is a rotation (doesn't count as a solve move)
  const isRotation = (move: string) => {
    return move.startsWith('x') || move.startsWith('y') || move.startsWith('z');
  };

  const handleMove = useCallback(
    (move: string) => {
      if (solo.phase !== 'inspecting' && solo.phase !== 'solving') return;

      // Apply move immediately for instant visual feedback
      cubeRef.current?.applyMove(move);

      // Also update state for tracking
      setMoves((prev) => [...prev, move]);

      // Track move with timestamp relative to inspection start (for ghost replay)
      moveSeqRef.current += 1;
      const seq = moveSeqRef.current;
      setMoveSeq(seq);

      // Calculate timestamp relative to inspection start (not solve start)
      // This allows ghost replay to show inspection rotations at the right time
      const tMs = Date.now() - solo.inspectionStartsAt;

      recordedMovesRef.current.push({ seq, move, tMs });

      // Only non-rotation moves start the timer
      if (isRotation(move)) {
        return;
      }

      // Start local timer if not already running (first non-rotation move)
      if (!timerRef.current) {
        setIsSolving(true); // Mark that user started solving
        solveStartTimeRef.current = Date.now();
        let lastUpdate = 0;

        const updateTimer = (timestamp: number) => {
          // Throttle to ~60fps
          if (timestamp - lastUpdate >= 16) {
            const elapsed = Date.now() - solveStartTimeRef.current;
            setSolveTime(elapsed);
            lastUpdate = timestamp;
          }
          timerRef.current = requestAnimationFrame(updateTimer);
        };
        timerRef.current = requestAnimationFrame(updateTimer);
      }
    },
    [solo.phase, solo.inspectionStartsAt]
  );

  // Stop timer and check if solved (called on spacebar)
  const handleStopTimer = useCallback(async () => {
    // Allow stopping if timer is running (either during inspection with early start, or solving phase)
    if (!timerRef.current) return;

    cancelAnimationFrame(timerRef.current);
    timerRef.current = null;

    // Calculate final time
    const finalTimeMs = Date.now() - solveStartTimeRef.current;

    // Check if cube is solved
    const isSolved = await cubeRef.current?.checkSolved() ?? false;

    // Send all recorded moves with the completion event
    // Include the client-calculated time since server doesn't track solve start anymore
    solo.sendComplete(recordedMovesRef.current, !isSolved, finalTimeMs);
  }, [solo.sendComplete]);

  // Spacebar handler for stopping timer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      // Allow spacebar when timer is running (user started solving)
      if (e.code === 'Space' && (solo.phase === 'solving' || (solo.phase === 'inspecting' && timerRef.current))) {
        e.preventDefault();
        handleStopTimer();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [solo.phase, handleStopTimer]);

  const handleStartSolo = () => {
    solo.startSolo(selectedSize);
  };

  const handlePlayAgain = () => {
    solo.reset();
  };

  const handleBackToDashboard = () => {
    solo.abandonSolo();
    router.push('/dashboard');
  };

  // Enable keyboard controls during inspection and solving
  useKeybindings({
    enabled: solo.phase === 'inspecting' || solo.phase === 'solving',
    onMove: handleMove,
  });

  if (!user) return null;

  // Idle state - show mode selection, then puzzle selection
  if (solo.phase === 'idle') {
    return (
      <div className="min-h-screen p-8">
        <div className="max-w-2xl mx-auto">
          <header className="flex justify-between items-center mb-8">
            <Link href="/dashboard" className="text-gray-400 hover:text-white">
              &larr; Back to Dashboard
            </Link>
            <h1 className="text-2xl font-bold">Ghost Mode</h1>
            <div className="w-32" />
          </header>

          <div className="grid gap-6 mb-8">
            <div className="card">
              <h2 className="text-xl font-semibold mb-2">Create Ghost Solves</h2>
              <p className="text-gray-400 mb-4">
                Record 5 solves that other players can race against. When someone races your ghost,
                you gain or lose MMR based on the result.
              </p>

              <div className="grid grid-cols-2 gap-3 mb-4">
                {PUZZLE_SIZES.map((size) => {
                  const isAvailable = AVAILABLE_SIZES.includes(size);
                  return (
                    <button
                      key={size}
                      onClick={() => isAvailable && setSelectedSize(size)}
                      disabled={!isAvailable}
                      className={`p-3 rounded-lg border-2 transition-all ${
                        selectedSize === size && isAvailable
                          ? 'border-blue-500 bg-blue-500/20'
                          : isAvailable
                          ? 'border-gray-700 hover:border-gray-600'
                          : 'border-gray-800 opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <div className="text-lg font-bold">{size}</div>
                      <div className="text-xs text-gray-400">
                        {isAvailable ? 'Available' : 'Coming Soon'}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                onClick={handleStartSolo}
                className="btn btn-primary w-full py-3 font-bold"
              >
                Create Ghost Solves
              </button>
            </div>

            <Link href="/solo/race" className="card block hover:bg-gray-800/50 transition-colors">
              <h2 className="text-xl font-semibold mb-2">Race Against Ghosts</h2>
              <p className="text-gray-400 mb-4">
                Race against other players' ghost solves. You'll be matched with ghosts near your skill level.
                Win to gain MMR, lose to drop MMR.
              </p>
              <div className="btn btn-secondary w-full py-3 font-bold text-center">
                Find Ghost Opponent
              </div>
            </Link>
          </div>

          <div className="card">
            <h3 className="font-semibold mb-2">How Ghost Mode Works</h3>
            <ul className="text-gray-400 text-sm space-y-1">
              <li>&#8226; Create ghost solves: Record 5 timed solves for others to race</li>
              <li>&#8226; Race against ghosts: Compete against recorded solves from other players</li>
              <li>&#8226; As a racer: You always gain/lose MMR based on the ghost's skill at recording time</li>
              <li>&#8226; As a ghost creator: Your MMR changes when others race your ghost (for 1 week)</li>
              <li>&#8226; Ghosts are matched by skill level (MMR at time of recording)</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // Session complete state - show summary
  if (solo.phase === 'session_complete') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-md w-full text-center">
          <h2 className="text-3xl font-bold mb-4">Ghost Solves Created!</h2>

          <div className="mb-6">
            <div className="text-gray-400 mb-2">Your Solves</div>
            <div className="space-y-2">
              {solo.solves.map((solve, i) => (
                <div
                  key={i}
                  className="flex justify-between items-center py-2 px-4 bg-gray-800 rounded"
                >
                  <span className="text-gray-400">Solve {solve.round}</span>
                  <span className={`font-mono font-bold ${solve.timeMs === null ? 'text-red-500' : ''}`}>
                    {formatTime(solve.timeMs)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {solo.averageTime !== null && (
            <div className="mb-6 p-4 bg-gray-800 rounded">
              <div className="text-gray-400 text-sm mb-1">Average</div>
              <div className="text-3xl font-mono font-bold">
                {formatTime(solo.averageTime)}
              </div>
            </div>
          )}

          <p className="text-gray-400 text-sm mb-6">
            Other players can now race against your ghost. You'll gain or lose MMR when they do!
          </p>

          <div className="flex gap-4">
            <button onClick={handlePlayAgain} className="btn btn-primary flex-1">
              Create More
            </button>
            <button onClick={handleBackToDashboard} className="btn btn-secondary flex-1">
              Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Active recording state
  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <header className="flex justify-between items-center mb-6">
          <button onClick={handleBackToDashboard} className="text-gray-400 hover:text-white">
            Abandon
          </button>
          <div className="text-center">
            <div className="text-sm text-gray-400">Creating Ghost Solves - {solo.puzzleSize}</div>
          </div>
          <div className="text-lg font-bold">
            Solve {solo.currentRound}/{solo.totalRounds}
          </div>
        </header>

        {/* Timer */}
        <div className="card mb-6 text-center">
          {solo.phase === 'inspecting' && !isSolving && (
            <>
              <div className="text-sm text-gray-400 mb-2">Inspection</div>
              <div className={`text-6xl font-mono font-bold ${inspectionTime <= 3 ? 'text-red-500' : ''}`}>
                {inspectionTime}
              </div>
            </>
          )}
          {(solo.phase === 'solving' || isSolving) && solo.phase !== 'round_complete' && (
            <>
              <div className="text-sm text-gray-400 mb-2">Solve</div>
              <div className="text-6xl font-mono font-bold">
                {formatTime(solveTime)}
              </div>
              <div className="text-sm text-gray-500 mt-2">Press SPACE when solved</div>
            </>
          )}
          {solo.phase === 'round_complete' && (
            <>
              <div className="text-sm text-gray-400 mb-2">Time Recorded</div>
              <div className="text-6xl font-mono font-bold text-green-500">
                {formatTime(solo.lastSolveTime)}
              </div>
              <div className="text-sm text-gray-500 mt-2">Next solve starting...</div>
            </>
          )}
          {solo.phase === 'starting' && (
            <div className="text-2xl text-gray-400">Get ready...</div>
          )}
        </div>

        {/* Scramble */}
        {solo.scramble && (solo.phase === 'inspecting' || solo.phase === 'solving') && (
          <div className="card mb-6">
            <p className="scramble-text text-lg text-center">{solo.scramble}</p>
          </div>
        )}

        {/* Cube */}
        {solo.scramble && (
          <div className="card mb-6">
            <TwistyCube
              ref={cubeRef}
              puzzleSize={solo.puzzleSize}
              scramble={solo.scramble}
              moves={moves}
              className="h-64 md:h-96"
            />
          </div>
        )}

        {/* Move count */}
        {solo.phase === 'solving' && (
          <div className="text-center text-gray-400">
            Moves: {moveSeq}
          </div>
        )}
      </div>
    </div>
  );
}
