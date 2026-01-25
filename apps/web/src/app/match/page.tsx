'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import { useSocket } from '@/hooks/useSocket';
import { useKeybindings } from '@/hooks/useKeybindings';
import { TwistyCube } from '@/components/TwistyCube';
import { Timer } from '@/components/Timer';
import { LeagueBadge } from '@/components/LeagueBadge';
import { INSPECTION_DURATION_MS } from '@plus2/shared';

export default function MatchPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const {
    phase,
    puzzleSize,
    matchId,
    opponent,
    currentRound,
    myScore,
    opponentScore,
    scramble,
    inspectionStartsAt,
    solveStartsAt,
    myMoves,
    opponentMoves,
    myTime,
    opponentTime,
    matchWinner,
    mmrDelta,
    newMmr,
    newLeague,
    addMyMove,
  } = useGameStore();

  const { sendMove, sendSolveComplete, sendRematch, sendRequeue } = useSocket();
  const moveSeqRef = useRef(0);

  // State for solving
  const [timerStart, setTimerStart] = useState<number | null>(null);
  const [isSolved, setIsSolved] = useState(false);

  // Redirect if no match
  useEffect(() => {
    if (!matchId && phase === 'idle') {
      router.push('/dashboard');
    }
  }, [matchId, phase, router]);

  // Handle inspection timer
  useEffect(() => {
    if (phase === 'inspecting' && inspectionStartsAt > 0) {
      // Inspection already started
      const elapsed = Date.now() - inspectionStartsAt;
      if (elapsed < INSPECTION_DURATION_MS) {
        setTimerStart(inspectionStartsAt);
      }
    }
  }, [phase, inspectionStartsAt]);

  // Handle solve start
  useEffect(() => {
    if (phase === 'solving' && solveStartsAt > 0) {
      setTimerStart(solveStartsAt);
      moveSeqRef.current = 0;
    }
  }, [phase, solveStartsAt]);

  // Handle move from keyboard
  const handleMove = useCallback(
    (move: string) => {
      if (phase !== 'inspecting' && phase !== 'solving') return;

      // If in inspection and making first move, this starts the solve
      // The server handles this transition

      moveSeqRef.current += 1;
      addMyMove(move);
      sendMove(moveSeqRef.current, move);

      // For MVP, we'll use a simple check
      // In production, validate cube state properly
      // This is a placeholder - actual solve detection needs cubing.js state checking
      if (myMoves.length > 20) {
        // Simulate solve completion after enough moves (for testing)
        // In reality, you'd check if cube is solved
      }
    },
    [phase, addMyMove, sendMove, myMoves.length]
  );

  // Handle spacebar for solve completion (placeholder for actual solve detection)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && phase === 'solving' && !isSolved) {
        e.preventDefault();
        setIsSolved(true);
        sendSolveComplete();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase, isSolved, sendSolveComplete]);

  // Use keybindings
  useKeybindings({
    enabled: phase === 'inspecting' || phase === 'solving',
    onMove: handleMove,
  });

  if (!user || !opponent) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading match...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-7xl mx-auto">
        {/* Match Header */}
        <header className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-4">
            <div className="text-xl font-bold">{puzzleSize}</div>
            <div className="text-gray-400">Round {currentRound} / 5</div>
          </div>
          <div className="text-2xl font-bold">
            <span className="text-green-500">{myScore}</span>
            <span className="text-gray-500 mx-2">-</span>
            <span className="text-red-500">{opponentScore}</span>
          </div>
        </header>

        {/* Scramble */}
        <div className="card mb-4 text-center">
          <p className="text-gray-400 text-sm mb-1">Scramble</p>
          <p className="scramble-text text-xl">{scramble || 'Waiting for scramble...'}</p>
        </div>

        {/* Main Game Area */}
        <div className="grid md:grid-cols-2 gap-4 mb-4">
          {/* My Cube */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="font-bold">{user.username}</span>
                <LeagueBadge league={user.league} size="sm" />
              </div>
              <span className="text-gray-400">{user.mmr} MMR</span>
            </div>

            <TwistyCube
              puzzleSize={puzzleSize}
              scramble={scramble}
              moves={myMoves}
              isInteractive
              className="h-64 mb-4"
            />

            <div className="text-center">
              <Timer
                startTime={timerStart}
                isRunning={phase === 'inspecting' || phase === 'solving'}
                finalTime={myTime}
                isInspection={phase === 'inspecting'}
                inspectionDuration={INSPECTION_DURATION_MS}
              />
              <p className="text-gray-400 mt-2">
                {phase === 'inspecting' && 'Inspection - press any move key to start'}
                {phase === 'solving' && 'Solving - press SPACE when done'}
                {phase === 'waiting_opponent' && 'Waiting for opponent...'}
              </p>
            </div>
          </div>

          {/* Opponent Cube */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="font-bold">{opponent.username}</span>
                <LeagueBadge league={opponent.league} size="sm" />
              </div>
              <span className="text-gray-400">{opponent.mmr} MMR</span>
            </div>

            <TwistyCube
              puzzleSize={puzzleSize}
              scramble={scramble}
              moves={opponentMoves}
              className="h-64 mb-4"
            />

            <div className="text-center">
              {opponentTime ? (
                <div className="timer text-4xl font-bold text-gray-400">
                  {(opponentTime / 1000).toFixed(2)}s
                </div>
              ) : (
                <div className="text-gray-400">
                  {opponentMoves.length > 0 ? 'Solving...' : 'Waiting...'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Round Result Overlay */}
        {phase === 'round_complete' && (
          <div className="card text-center mb-4">
            <h2 className="text-2xl font-bold mb-2">
              {myTime && opponentTime
                ? myTime < opponentTime
                  ? 'You Win This Round!'
                  : 'Opponent Wins This Round'
                : 'Round Complete'}
            </h2>
            <p className="text-gray-400">
              Your time: {myTime ? `${(myTime / 1000).toFixed(2)}s` : 'DNF'}
              {' | '}
              Opponent: {opponentTime ? `${(opponentTime / 1000).toFixed(2)}s` : 'DNF'}
            </p>
          </div>
        )}

        {/* Match Complete Overlay */}
        {phase === 'match_complete' && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="card max-w-md w-full text-center">
              <h1 className="text-4xl font-bold mb-4">
                {matchWinner === 'you' ? (
                  <span className="text-green-500">Victory!</span>
                ) : (
                  <span className="text-red-500">Defeat</span>
                )}
              </h1>

              <div className="text-6xl font-bold mb-6">
                <span className="text-green-500">{myScore}</span>
                <span className="text-gray-500 mx-4">-</span>
                <span className="text-red-500">{opponentScore}</span>
              </div>

              <div className="mb-6">
                <p className="text-gray-400 mb-2">Rating Change</p>
                <p className={`text-3xl font-bold ${mmrDelta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {mmrDelta >= 0 ? '+' : ''}{mmrDelta}
                </p>
                <p className="text-gray-400 mt-2">
                  New Rating: {newMmr} MMR
                </p>
                {newLeague && (
                  <div className="mt-2">
                    <LeagueBadge league={newLeague} />
                  </div>
                )}
              </div>

              <div className="flex gap-4 justify-center">
                <button onClick={sendRematch} className="btn btn-primary">
                  Rematch
                </button>
                <button onClick={sendRequeue} className="btn btn-secondary">
                  New Opponent
                </button>
                <button
                  onClick={() => router.push('/dashboard')}
                  className="btn btn-secondary"
                >
                  Leave
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
