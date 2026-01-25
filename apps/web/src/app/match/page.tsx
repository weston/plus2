'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import { useSocket } from '@/hooks/useSocket';
import { useKeybindings } from '@/hooks/useKeybindings';
import { TwistyCube, TwistyCubeHandle } from '@/components/TwistyCube';
import { Timer } from '@/components/Timer';
import { LeagueBadge } from '@/components/LeagueBadge';
import { INSPECTION_DURATION_MS } from '@plus2/shared';

// Rotation moves don't start the solve timer
const ROTATION_MOVES = ['x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'];

function isRotationMove(move: string): boolean {
  return ROTATION_MOVES.includes(move);
}

export default function MatchPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const {
    phase,
    setPhase,
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
    opponentSolveStartedAt,
    matchWinner,
    mmrDelta,
    newMmr,
    newLeague,
    addMyMove,
    setSolveComplete,
  } = useGameStore();

  const { sendMove, sendSolveComplete, sendRematch, sendRequeue } = useSocket();
  const moveSeqRef = useRef(0);
  const cubeRef = useRef<TwistyCubeHandle>(null);

  // Timer state for my cube (opponent uses server timestamp from store)
  const [myTimerStart, setMyTimerStart] = useState<number | null>(null);
  const [myTimerRunning, setMyTimerRunning] = useState(false);
  const [isSolved, setIsSolved] = useState(false);
  const [inspectionTimeLeft, setInspectionTimeLeft] = useState(15);

  // Redirect if no match
  useEffect(() => {
    if (!matchId && phase === 'idle') {
      router.push('/dashboard');
    }
  }, [matchId, phase, router]);

  // Reset state on new round
  useEffect(() => {
    if (phase === 'inspecting') {
      setMyTimerStart(null);
      setMyTimerRunning(false);
      setIsSolved(false);
      moveSeqRef.current = 0;
    }
  }, [phase, currentRound]);

  // Inspection countdown
  useEffect(() => {
    if (phase !== 'inspecting' || !inspectionStartsAt) return;

    const interval = setInterval(() => {
      const elapsed = Date.now() - inspectionStartsAt;
      const remaining = Math.max(0, Math.ceil((INSPECTION_DURATION_MS - elapsed) / 1000));
      setInspectionTimeLeft(remaining);
    }, 100);

    return () => clearInterval(interval);
  }, [phase, inspectionStartsAt]);

  // Auto-start timer when inspection ends (phase changes to 'solving')
  useEffect(() => {
    if (phase === 'solving' && !myTimerStart && !isSolved) {
      // Use solveStartsAt from server if available, otherwise use current time
      const startTime = solveStartsAt || Date.now();
      setMyTimerStart(startTime);
      setMyTimerRunning(true);
    }
  }, [phase, myTimerStart, isSolved, solveStartsAt]);

  // Handle move from keyboard
  const handleMove = useCallback(
    (move: string) => {
      if (phase !== 'inspecting' && phase !== 'solving') return;

      moveSeqRef.current += 1;
      addMyMove(move);
      sendMove(moveSeqRef.current, move);

      // If this is a non-rotation move and timer hasn't started, start it
      if (!isRotationMove(move) && !myTimerStart) {
        setMyTimerStart(Date.now());
        setMyTimerRunning(true);
        if (phase === 'inspecting') {
          setPhase('solving');
        }
      }
    },
    [phase, addMyMove, sendMove, myTimerStart, setPhase]
  );

  // Handle spacebar for solve completion
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.code === 'Space' && phase === 'solving' && myTimerRunning && !isSolved) {
        e.preventDefault();
        const solveTime = myTimerStart ? Date.now() - myTimerStart : 0;

        // Check if cube is actually solved
        const cubeSolved = await cubeRef.current?.checkSolved() ?? false;

        setIsSolved(cubeSolved);
        setMyTimerRunning(false);
        setSolveComplete(cubeSolved ? solveTime : null); // null time = DNF
        sendSolveComplete();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase, myTimerRunning, isSolved, myTimerStart, sendSolveComplete, setSolveComplete]);

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

        {/* Scramble and Inspection Timer */}
        <div className="card mb-4 text-center">
          {phase === 'inspecting' && (
            <div className={`text-6xl font-bold mb-2 ${
              inspectionTimeLeft <= 3 ? 'text-red-500' :
              inspectionTimeLeft <= 8 ? 'text-yellow-500' : 'text-green-500'
            }`}>
              {inspectionTimeLeft}s
            </div>
          )}
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
              ref={cubeRef}
              puzzleSize={puzzleSize}
              scramble={scramble}
              moves={myMoves}
              isInteractive
              className="h-64 mb-4"
            />

            <div className="text-center">
              <Timer
                startTime={myTimerStart}
                isRunning={myTimerRunning}
                finalTime={isSolved ? myTime : undefined}
              />
              <p className="text-gray-400 mt-2">
                {phase === 'inspecting' && !myTimerStart && 'Inspection - make a move to start solving'}
                {phase === 'inspecting' && myTimerStart && 'Solving...'}
                {phase === 'solving' && myTimerRunning && 'Press SPACE when solved'}
                {phase === 'solving' && !myTimerRunning && isSolved && 'Done!'}
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
              <Timer
                startTime={opponentSolveStartedAt}
                isRunning={opponentSolveStartedAt !== null && !opponentTime}
                finalTime={opponentTime}
              />
              <p className="text-gray-400 mt-2">
                {!opponentSolveStartedAt && phase === 'inspecting' && 'Inspecting...'}
                {!opponentSolveStartedAt && phase === 'solving' && 'Inspecting...'}
                {opponentSolveStartedAt && !opponentTime && 'Solving...'}
                {opponentTime && 'Done!'}
              </p>
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
