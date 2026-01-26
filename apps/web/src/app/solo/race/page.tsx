'use client';

import { Suspense, useEffect, useState, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { useGhostRaceSocket } from '@/hooks/useGhostRaceSocket';
import { useKeybindings } from '@/hooks/useKeybindings';
import { TwistyCube, TwistyCubeHandle } from '@/components/TwistyCube';
import { LeagueBadge } from '@/components/LeagueBadge';
import { CountryFlag } from '@/components/CountryFlag';
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

// Wrapper component to handle Suspense boundary for useSearchParams
export default function GhostRacePage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-gray-400">Loading...</p></div>}>
      <GhostRaceContent />
    </Suspense>
  );
}

function GhostRaceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const opponentId = searchParams.get('opponent');
  const { user, accessToken, _hasHydrated } = useAuthStore();
  const race = useGhostRaceSocket();

  const [selectedSize, setSelectedSize] = useState<PuzzleSize>('3x3');
  const [inspectionTime, setInspectionTime] = useState(15);
  const [solveTime, setSolveTime] = useState(0);
  const [moveSeq, setMoveSeq] = useState(0);
  const [moves, setMoves] = useState<string[]>([]);
  const [isSolving, setIsSolving] = useState(false);
  const moveSeqRef = useRef(0);

  const timerRef = useRef<number | null>(null);
  const solveStartTimeRef = useRef(0);
  const cubeRef = useRef<TwistyCubeHandle>(null);
  const ghostCubeRef = useRef<TwistyCubeHandle>(null);

  // Ghost replay state
  const [ghostMoves, setGhostMoves] = useState<string[]>([]);
  const ghostReplayRef = useRef<NodeJS.Timeout | null>(null);
  const [waitingForGhost, setWaitingForGhost] = useState(false);
  const [playerFinishedTime, setPlayerFinishedTime] = useState<number | null>(null);

  // Redirect if not logged in
  useEffect(() => {
    if (_hasHydrated && (!user || !accessToken)) {
      router.push('/login');
    }
  }, [user, accessToken, router, _hasHydrated]);

  // Start replaying ghost moves from inspection start
  const startGhostReplay = useCallback(() => {
    if (!race.ghostMoves || race.ghostMoves.length === 0) {
      setWaitingForGhost(false);
      return;
    }
    if (ghostReplayRef.current) return; // Already running

    let moveIndex = 0;
    const ghostInspectionStart = race.ghostInspectionStartAt;

    ghostReplayRef.current = setInterval(() => {
      // Calculate elapsed time since our inspection started
      const elapsed = Date.now() - race.inspectionStartsAt;

      // Apply all ghost moves that should have happened by now
      while (moveIndex < race.ghostMoves.length) {
        const move = race.ghostMoves[moveIndex];

        // Calculate when this move should play relative to inspection start
        let moveTime: number;
        if (move.tMs !== undefined) {
          // tMs is now relative to inspection start - use directly
          moveTime = move.tMs;
        } else if (move.serverTs && ghostInspectionStart) {
          // Legacy: use serverTs relative to ghost's inspection start
          moveTime = move.serverTs - ghostInspectionStart;
        } else {
          // Fallback: spread moves evenly starting at 15s
          moveTime = 15000 + (moveIndex * 200);
        }

        if (elapsed >= moveTime) {
          setGhostMoves((prev) => [...prev, move.move]);
          moveIndex++;
        } else {
          break;
        }
      }

      // Stop when all moves are applied
      if (moveIndex >= race.ghostMoves.length) {
        if (ghostReplayRef.current) {
          clearInterval(ghostReplayRef.current);
          ghostReplayRef.current = null;
        }
        // Ghost has finished - no longer waiting
        setWaitingForGhost(false);
      }
    }, 50);
  }, [race.ghostMoves, race.ghostInspectionStartAt, race.inspectionStartsAt]);

  // Auto-advance to next round after ghost finishes and results are shown
  const nextRoundTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // When round is complete and we're not waiting for ghost, start auto-advance timer
    if (race.phase === 'round_complete' && !waitingForGhost && race.currentRound < race.totalRounds) {
      // Clear any existing timer
      if (nextRoundTimerRef.current) {
        clearTimeout(nextRoundTimerRef.current);
      }
      // Auto-advance after 3 seconds
      nextRoundTimerRef.current = setTimeout(() => {
        race.skipToNextRound();
        nextRoundTimerRef.current = null;
      }, 3000);
    }

    return () => {
      if (nextRoundTimerRef.current) {
        clearTimeout(nextRoundTimerRef.current);
        nextRoundTimerRef.current = null;
      }
    };
  }, [race.phase, waitingForGhost, race.currentRound, race.totalRounds, race.skipToNextRound]);

  // Handle inspection countdown and reset state for new round
  useEffect(() => {
    if (race.phase === 'inspecting' && race.inspectionStartsAt > 0) {
      // Reset state for new round
      setMoves([]);
      setGhostMoves([]);
      moveSeqRef.current = 0;
      setMoveSeq(0);
      setSolveTime(0);
      setIsSolving(false);
      setWaitingForGhost(false);
      setPlayerFinishedTime(null);
      if (timerRef.current) {
        cancelAnimationFrame(timerRef.current);
        timerRef.current = null;
      }
      if (ghostReplayRef.current) {
        clearInterval(ghostReplayRef.current);
        ghostReplayRef.current = null;
      }

      const updateInspection = () => {
        const now = Date.now();
        const elapsed = now - race.inspectionStartsAt;
        const remaining = Math.max(0, Math.ceil((15000 - elapsed) / 1000));
        setInspectionTime(remaining);
      };

      updateInspection();
      const interval = setInterval(updateInspection, 100);

      // Start ghost replay at inspection start
      startGhostReplay();

      return () => clearInterval(interval);
    }
  }, [race.phase, race.inspectionStartsAt, startGhostReplay]);

  // Handle solve timer - only start if user didn't already start during inspection
  useEffect(() => {
    if (race.phase === 'solving' && race.solveStartsAt > 0) {
      setInspectionTime(0);

      // Only start timer if user didn't already start during inspection
      if (!timerRef.current) {
        solveStartTimeRef.current = race.solveStartsAt;
        setMoves([]);
        moveSeqRef.current = 0;
        setMoveSeq(0);

        let lastUpdate = 0;
        const updateTimer = (timestamp: number) => {
          if (timestamp - lastUpdate >= 16) {
            const elapsed = Date.now() - race.solveStartsAt;
            setSolveTime(elapsed);
            lastUpdate = timestamp;
          }
          timerRef.current = requestAnimationFrame(updateTimer);
        };
        timerRef.current = requestAnimationFrame(updateTimer);
      }
    }
  }, [race.phase, race.solveStartsAt]);

  // Check if move is a rotation
  const isRotation = (move: string) => {
    return move.startsWith('x') || move.startsWith('y') || move.startsWith('z');
  };

  const handleMove = useCallback(
    (move: string) => {
      if (race.phase !== 'inspecting' && race.phase !== 'solving') return;

      // Apply move immediately for instant visual feedback
      cubeRef.current?.applyMove(move);

      // Also update state for tracking
      setMoves((prev) => [...prev, move]);

      // Send all moves to server (including rotations)
      moveSeqRef.current += 1;
      const seq = moveSeqRef.current;
      setMoveSeq(seq);
      race.sendMove(seq, move);

      // Only non-rotation moves start the timer
      if (isRotation(move)) {
        return;
      }

      // Start local timer if not already running (first non-rotation move)
      if (!timerRef.current) {
        setIsSolving(true);
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
    [race.phase, race.sendMove]
  );

  // Stop timer and check if solved
  const handleStopTimer = useCallback(async () => {
    if (!timerRef.current) return;

    cancelAnimationFrame(timerRef.current);
    timerRef.current = null;

    // Record player's finish time
    const finishTime = Date.now() - solveStartTimeRef.current;
    setPlayerFinishedTime(finishTime);

    // If ghost replay is still running, wait for it to finish
    if (ghostReplayRef.current) {
      setWaitingForGhost(true);
    }

    // Check if cube is solved
    const isSolved = await cubeRef.current?.checkSolved() ?? false;

    if (isSolved) {
      race.sendComplete();
    } else {
      race.sendComplete();
    }
  }, [race.sendComplete]);

  // Spacebar handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.code === 'Space' && (race.phase === 'solving' || (race.phase === 'inspecting' && timerRef.current))) {
        e.preventDefault();
        handleStopTimer();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [race.phase, handleStopTimer]);

  const handleStartRace = () => {
    race.startRace(selectedSize, opponentId || undefined);
  };

  const handlePlayAgain = () => {
    race.reset();
  };

  const handleBackToDashboard = () => {
    race.abandonRace();
    router.push('/dashboard');
  };

  // Enable keyboard controls
  useKeybindings({
    enabled: race.phase === 'inspecting' || race.phase === 'solving',
    onMove: handleMove,
  });

  if (!user) return null;

  // Idle state - show start screen
  if (race.phase === 'idle') {
    return (
      <div className="min-h-screen p-8">
        <div className="max-w-2xl mx-auto">
          <header className="flex justify-between items-center mb-8">
            <Link href="/solo" className="text-gray-400 hover:text-white">
              &larr; Back to Ghost Mode
            </Link>
            <h1 className="text-2xl font-bold">Race Against Ghost</h1>
            <div className="w-32" />
          </header>

          <div className="card">
            <h2 className="text-xl font-semibold mb-4">Find a Ghost Opponent</h2>
            <p className="text-gray-400 mb-6">
              Race against another player's recorded ghost solves. You'll be matched with ghosts near your skill level.
            </p>

            {race.error && (
              <div className="bg-red-500/20 border border-red-500 rounded-lg p-4 mb-6">
                <p className="text-red-400">{race.error}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mb-6">
              {PUZZLE_SIZES.map((size) => {
                const isAvailable = AVAILABLE_SIZES.includes(size);
                return (
                  <button
                    key={size}
                    onClick={() => isAvailable && setSelectedSize(size)}
                    disabled={!isAvailable}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      selectedSize === size && isAvailable
                        ? 'border-blue-500 bg-blue-500/20'
                        : isAvailable
                        ? 'border-gray-700 hover:border-gray-600'
                        : 'border-gray-800 opacity-50 cursor-not-allowed'
                    }`}
                  >
                    <div className="text-xl font-bold">{size}</div>
                    <div className="text-sm text-gray-400">
                      {isAvailable ? 'Available' : 'Coming Soon'}
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              onClick={handleStartRace}
              className="btn btn-primary w-full py-4 text-lg font-bold"
            >
              {opponentId ? 'Race Against This Player\'s Ghost' : 'Find Ghost Opponent'}
            </button>
          </div>

          <div className="card mt-6">
            <h3 className="font-semibold mb-2">MMR Rules for Ghost Races</h3>
            <ul className="text-gray-400 text-sm space-y-1">
              <li>&#8226; You always gain or lose MMR based on the ghost's skill at recording time</li>
              <li>&#8226; Ghost creators gain/lose MMR when you race their ghost (if less than 1 week old)</li>
              <li>&#8226; Older ghosts (1+ week) no longer affect the creator's MMR</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // Race complete state
  if (race.phase === 'race_complete') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-md w-full text-center">
          <h2 className="text-3xl font-bold mb-4">
            {race.userWon ? (
              <span className="text-green-500">Victory!</span>
            ) : (
              <span className="text-red-500">Defeat</span>
            )}
          </h2>

          <p className="text-gray-400 mb-4">
            vs {race.ghostUsername}'s Ghost
            {race.isOldGhost && <span className="text-yellow-500 ml-2">(Old Ghost)</span>}
          </p>

          <div className="text-5xl font-bold mb-6">
            <span className={race.userWins > race.ghostWins ? 'text-green-500' : ''}>{race.userWins}</span>
            <span className="text-gray-500 mx-4">-</span>
            <span className={race.ghostWins > race.userWins ? 'text-green-500' : ''}>{race.ghostWins}</span>
          </div>

          <div className="mb-6 p-4 bg-gray-800 rounded">
            <div className="text-gray-400 text-sm mb-1">Rating Change</div>
            <div className={`text-3xl font-bold ${race.mmrDelta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {race.mmrDelta >= 0 ? '+' : ''}{race.mmrDelta}
            </div>
            <div className="text-gray-400 text-sm mt-2">
              New Rating: {race.newMmr}
              {race.newLeague && <LeagueBadge league={race.newLeague} size="sm" className="ml-2 inline-block" />}
            </div>
            {race.isOldGhost && (
              <div className="text-yellow-500 text-xs mt-2">
                Old ghost - creator's MMR was not affected
              </div>
            )}
          </div>

          <div className="flex gap-4">
            <button onClick={handlePlayAgain} className="btn btn-primary flex-1">
              Race Again
            </button>
            <button onClick={handleBackToDashboard} className="btn btn-secondary flex-1">
              Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Active race state
  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex justify-between items-center mb-6">
          <button onClick={handleBackToDashboard} className="text-gray-400 hover:text-white">
            Abandon
          </button>
          <div className="text-center">
            <div className="text-sm text-gray-400 flex items-center justify-center gap-2">
              Racing vs
              {race.ghostCountry && <CountryFlag country={race.ghostCountry} size="sm" />}
              <span>{race.ghostUsername}'s Ghost</span>
              <span>({race.ghostMmr} MMR)</span>
            </div>
            <div className="text-xs text-gray-500">
              {race.ghostGamesPlayed > 0 ? (
                <span>
                  {race.ghostGamesWon}W - {race.ghostGamesPlayed - race.ghostGamesWon}L
                </span>
              ) : null}
            </div>
            {race.isOldGhost && (
              <div className="text-xs text-yellow-500">Old ghost - creator's MMR not affected</div>
            )}
          </div>
          <div className="text-lg font-bold">
            Round {race.currentRound}/{race.totalRounds}
          </div>
        </header>

        {/* Score */}
        <div className="card mb-6">
          <div className="flex justify-center items-center gap-8">
            <div className="text-center">
              <div className="text-sm text-gray-400 mb-1">You</div>
              <div className="text-4xl font-bold text-green-500">{race.userWins}</div>
            </div>
            <div className="text-2xl text-gray-500">vs</div>
            <div className="text-center">
              <div className="text-sm text-gray-400 mb-1">Ghost</div>
              <div className="text-4xl font-bold text-red-500">{race.ghostWins}</div>
            </div>
          </div>
        </div>

        {/* Timer */}
        <div className="card mb-6 text-center">
          {race.phase === 'inspecting' && !isSolving && (
            <>
              <div className="text-sm text-gray-400 mb-2">Inspection</div>
              <div className={`text-6xl font-mono font-bold ${inspectionTime <= 3 ? 'text-red-500' : ''}`}>
                {inspectionTime}
              </div>
            </>
          )}
          {(race.phase === 'solving' || isSolving) && race.phase !== 'round_complete' && !playerFinishedTime && (
            <>
              <div className="text-sm text-gray-400 mb-2">Solve</div>
              <div className="text-6xl font-mono font-bold">
                {formatTime(solveTime)}
              </div>
              <div className="text-sm text-gray-500 mt-2">Press SPACE when solved</div>
            </>
          )}
          {/* Player finished but waiting for ghost to complete */}
          {waitingForGhost && playerFinishedTime && (
            <>
              <div className="text-sm text-green-400 mb-2">You finished!</div>
              <div className="text-4xl font-mono font-bold text-green-500">
                {formatTime(playerFinishedTime)}
              </div>
              <div className="text-sm text-gray-400 mt-2">Watching ghost finish...</div>
              <button
                onClick={() => {
                  if (ghostReplayRef.current) {
                    clearInterval(ghostReplayRef.current);
                    ghostReplayRef.current = null;
                  }
                  setWaitingForGhost(false);
                }}
                className="btn btn-secondary px-4 py-1 mt-3 text-sm"
              >
                Skip
              </button>
            </>
          )}
          {race.phase === 'round_complete' && !waitingForGhost && (
            <>
              <div className="text-sm text-gray-400 mb-2">
                {race.lastUserWonRound ? 'You won this round!' : 'Ghost won this round'}
              </div>
              <div className="flex justify-center gap-8">
                <div className="text-center">
                  <div className="text-xs text-gray-500">Your Time</div>
                  <div className={`text-3xl font-mono font-bold ${race.lastUserWonRound ? 'text-green-500' : 'text-red-500'}`}>
                    {formatTime(race.lastUserTime)}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-500">Ghost Time</div>
                  <div className="text-3xl font-mono font-bold text-gray-400">
                    {formatTime(race.lastGhostTime)}
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-center gap-2 mt-3">
                <button
                  onClick={() => race.skipToNextRound()}
                  className="btn btn-secondary px-6 py-2"
                >
                  Skip to Next Round
                </button>
                <div className="text-xs text-gray-500">or wait 3 seconds...</div>
              </div>
            </>
          )}
          {race.phase === 'starting' && (
            <div className="text-2xl text-gray-400">Finding ghost opponent...</div>
          )}
        </div>

        {/* Scramble */}
        {race.scramble && (race.phase === 'inspecting' || race.phase === 'solving' || waitingForGhost) && (
          <div className="card mb-6">
            <p className="scramble-text text-lg text-center">{race.scramble}</p>
          </div>
        )}

        {/* Cubes */}
        {race.scramble && (
          <div className="grid md:grid-cols-2 gap-6 mb-6">
            {/* Your cube */}
            <div className="card">
              <div className="text-center text-sm text-gray-400 mb-2">Your Cube</div>
              <TwistyCube
                ref={cubeRef}
                puzzleSize={race.puzzleSize}
                scramble={race.scramble}
                moves={moves}
                className="h-48 md:h-64"
              />
            </div>

            {/* Ghost cube */}
            <div className="card">
              <div className="text-center text-sm text-gray-400 mb-2">
                {race.ghostUsername}'s Ghost
                {race.ghostTime && (
                  <span className="ml-2 text-yellow-500">
                    (Target: {formatTime(race.ghostTime)})
                  </span>
                )}
              </div>
              <TwistyCube
                ref={ghostCubeRef}
                puzzleSize={race.puzzleSize}
                scramble={race.scramble}
                moves={ghostMoves}
                className="h-48 md:h-64"
              />
            </div>
          </div>
        )}

        {/* Move count */}
        {(race.phase === 'solving' || isSolving) && race.phase !== 'round_complete' && (
          <div className="text-center text-gray-400">
            Moves: {moveSeq}
          </div>
        )}
      </div>
    </div>
  );
}
