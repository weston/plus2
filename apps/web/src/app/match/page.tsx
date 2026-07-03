'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import { useChatStore } from '@/stores/chatroom';
import { useCubePrefs } from '@/stores/cubePrefs';
import { useSocket } from '@/hooks/useSocket';
import { useKeybindings } from '@/hooks/useKeybindings';
import { TwistyCube, TwistyCubeHandle } from '@/components/TwistyCube';
import { Timer } from '@/components/Timer';
import { LeagueBadge } from '@/components/LeagueBadge';
import { CountryFlag } from '@/components/CountryFlag';
import { INSPECTION_DURATION_MS } from '@plus2/shared';

// Rotation moves don't start the solve timer
const ROTATION_MOVES = ['x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'];

function isRotationMove(move: string): boolean {
  return ROTATION_MOVES.includes(move);
}

// Format time in MM:SS.cc or SS.cc format
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((ms % 1000) / 10);

  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
  }
  return `${seconds}.${centiseconds.toString().padStart(2, '0')}`;
}

// Hook for deterministic opponent timer display
function useOpponentTimerDisplay() {
  const { opponentLocalSolveStartPerf, opponentTime, opponentSolveReceivedAt, opponentDone } = useGameStore();
  const [displayTime, setDisplayTime] = useState<number>(0);

  useEffect(() => {
    // If we have final time, show it
    if (opponentTime !== null) {
      setDisplayTime(opponentTime);
      return;
    }

    // Done with no time = DNF — stop ticking (rendering handled by caller)
    if (opponentDone) {
      return;
    }

    // If opponent hasn't started, don't show timer
    if (opponentLocalSolveStartPerf === null) {
      setDisplayTime(0);
      return;
    }

    // Run timer based on deterministic solve start
    const interval = setInterval(() => {
      const nowPerf = performance.now();
      const elapsed = Math.max(0, nowPerf - opponentLocalSolveStartPerf);
      setDisplayTime(elapsed);
    }, 10);

    return () => clearInterval(interval);
  }, [opponentLocalSolveStartPerf, opponentTime, opponentDone]);

  return {
    displayTime,
    isRunning: opponentLocalSolveStartPerf !== null && opponentTime === null && !opponentDone,
    // Fallback: use legacy field if deterministic isn't set
    hasStarted: opponentLocalSolveStartPerf !== null || opponentSolveReceivedAt !== null,
  };
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
    opponentDone,
    opponentSolveReceivedAt, // Local time when we received opponent_started
    opponentLocalSolveStartPerf, // Deterministic opponent solve start
    matchWinner,
    mmrDelta,
    newMmr,
    newLeague,
    addMyMove,
    setSolveComplete,
    setMySolveStart,
    mySolveStartServerMs,
    myLocalSolveStartPerf,
    solveId,
  } = useGameStore();

  const { sendMove, sendSolveComplete, sendRematch, sendRequeue, sendMatchRejoin, sendMatchLeave, sendResign, sendMatchChat } = useSocket();
  const matchMessages = useChatStore((s) => s.matchMessages);
  const myCubeColors = useCubePrefs((s) => s.colors);
  const [chatDraft, setChatDraft] = useState('');
  const chatListRef = useRef<HTMLDivElement>(null);

  // Keep the newest chat message in view.
  useEffect(() => {
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [matchMessages]);

  const submitChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatDraft.trim();
    if (!text) return;
    sendMatchChat(text);
    setChatDraft('');
  };

  // Two-step resign: first click arms the confirm, second click concedes.
  const [confirmResign, setConfirmResign] = useState(false);
  const confirmResignTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleResign = () => {
    if (!confirmResign) {
      setConfirmResign(true);
      if (confirmResignTimer.current) clearTimeout(confirmResignTimer.current);
      confirmResignTimer.current = setTimeout(() => setConfirmResign(false), 4000);
      return;
    }
    if (confirmResignTimer.current) clearTimeout(confirmResignTimer.current);
    setConfirmResign(false);
    sendResign();
  };
  const moveSeqRef = useRef(0);
  const cubeRef = useRef<TwistyCubeHandle>(null);
  // Synchronous guard so two keydowns in the same frame can't both start the
  // solve timer (state updates don't apply until the next render).
  const solveStartedRef = useRef(false);

  // Timer state for my cube (opponent uses server timestamp from store)
  const [myTimerStart, setMyTimerStart] = useState<number | null>(null);
  const [myTimerRunning, setMyTimerRunning] = useState(false);
  const [isSolved, setIsSolved] = useState(false);
  const [inspectionTimeLeft, setInspectionTimeLeft] = useState(15);

  // Deterministic opponent timer
  const opponentTimer = useOpponentTimerDisplay();

  // Redirect if no match
  useEffect(() => {
    if (!matchId && phase === 'idle') {
      router.push('/dashboard');
    }
  }, [matchId, phase, router]);

  // Attach this page to any live match on mount (the shared socket survives
  // navigation, so this replaces the old "new page = new connection = rejoin"
  // flow), and detach when leaving mid-match so the server starts its abandon
  // grace period. After the match is over there's nothing to abandon.
  useEffect(() => {
    sendMatchRejoin();
    return () => {
      const { phase: p, matchId: m } = useGameStore.getState();
      const matchActive =
        !!m && ['matched', 'inspecting', 'solving', 'waiting_opponent', 'round_complete'].includes(p);
      if (matchActive) {
        sendMatchLeave();
      }
    };
  }, [sendMatchRejoin, sendMatchLeave]);

  // Reset state on new round
  useEffect(() => {
    if (phase === 'inspecting') {
      setMyTimerStart(null);
      setMyTimerRunning(false);
      setIsSolved(false);
      moveSeqRef.current = 0;
      solveStartedRef.current = false;
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
    if (phase === 'solving' && !solveStartedRef.current && !isSolved) {
      solveStartedRef.current = true;
      const nowPerf = performance.now();
      const nowDate = Date.now();
      // Timer display uses local time. On a mid-solve REJOIN the server's
      // authoritative solve start is well in the past — map it to local time
      // so the timer continues from the real elapsed instead of restarting
      // at 0. Live starts keep using "now" (mapping noise would skew them).
      const { mySolveStartServerMs: solveStartSrv, serverOffsetMs } = useGameStore.getState();
      let timerStart = nowDate;
      if (solveStartSrv) {
        const mapped = solveStartSrv - serverOffsetMs;
        if (mapped < nowDate - 2000) {
          timerStart = mapped;
        }
      }
      setMyTimerStart(timerStart);
      setMyTimerRunning(true);
      // Set local solve start perf for tMs calculation (if not already set by a move)
      if (myLocalSolveStartPerf === null) {
        setMySolveStart(nowDate, nowPerf);
      }
    }
  }, [phase, myTimerStart, isSolved, myLocalSolveStartPerf, setMySolveStart]);

  // Handle move from keyboard
  const handleMove = useCallback(
    (move: string) => {
      if (phase !== 'inspecting' && phase !== 'solving') return;

      // Apply move to cube immediately for instant visual feedback (bypasses React render cycle)
      cubeRef.current?.applyMove(move);

      moveSeqRef.current += 1;
      addMyMove(move);

      // If this is a non-rotation move and timer hasn't started, start it.
      // Use a synchronous ref guard so rapid first moves can't double-start and
      // reset the solve-start timestamp.
      // MUST set local solve start perf BEFORE sending move (for correct tMs calculation)
      if (!isRotationMove(move) && !solveStartedRef.current) {
        solveStartedRef.current = true;
        const nowPerf = performance.now();
        const nowDate = Date.now();
        setMyTimerStart(nowDate);
        setMyTimerRunning(true);
        // Set local solve start perf for tMs calculation
        // Server will send authoritative time, but we need local ref for move timestamps
        setMySolveStart(nowDate, nowPerf); // Use Date.now() as approximate server time until we get authoritative
        if (phase === 'inspecting') {
          setPhase('solving');
        }
      }

      sendMove(moveSeqRef.current, move);
    },
    [phase, addMyMove, sendMove, myTimerStart, setPhase, setMySolveStart]
  );

  // Complete the current solve (shared by spacebar and cube auto-detect).
  const completeSolve = useCallback(async () => {
    if (phase !== 'solving' || !myTimerRunning || isSolved) return;
    const solveTime = myTimerStart ? Date.now() - myTimerStart : 0;

    // Check if cube is actually solved
    const cubeSolved = (await cubeRef.current?.checkSolved()) ?? false;

    setIsSolved(cubeSolved);
    setMyTimerRunning(false);

    // Don't set myTime locally - wait for server to send it back so both
    // players see the exact same value.
    sendSolveComplete(cubeSolved ? solveTime : null);
  }, [phase, myTimerRunning, isSolved, myTimerStart, sendSolveComplete]);

  // Spacebar also completes the solve — but never while typing in the chat
  // (or any other input), where Space is just a space.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        void completeSolve();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [completeSolve]);

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
          {phase !== 'match_complete' ? (
            <button
              onClick={handleResign}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                confirmResign
                  ? 'bg-red-600 hover:bg-red-700 text-white font-bold'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {confirmResign ? 'Confirm resign?' : 'Resign'}
            </button>
          ) : (
            <div className="w-20" />
          )}
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
              onSolved={completeSolve}
              isInteractive
              faceColors={myCubeColors}
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
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {opponent.country && <CountryFlag country={opponent.country} size="md" />}
                <span className="font-bold">{opponent.username}</span>
                <LeagueBadge league={opponent.league} size="sm" />
                {/* Matches are always vs a live human (ghosts race on /solo/race) */}
                <span className="text-[10px] font-bold bg-red-600 text-white rounded px-1.5 py-0.5 animate-pulse">
                  LIVE
                </span>
              </div>
              <span className="text-gray-400">{opponent.mmr} MMR</span>
            </div>
            <div className="text-xs text-gray-500 mb-4">
              {opponent.gamesPlayed > 0 ? (
                <span>
                  {opponent.gamesWon}W - {opponent.gamesPlayed - opponent.gamesWon}L
                  {' '}
                  ({Math.round((opponent.gamesWon / opponent.gamesPlayed) * 100)}% WR)
                </span>
              ) : (
                <span>No games played</span>
              )}
            </div>

            <TwistyCube
              puzzleSize={puzzleSize}
              scramble={scramble}
              moves={opponentMoves}
              faceColors={opponent.cubeColors}
              className="h-64 mb-4"
            />

            <div className="text-center">
              {/* Use deterministic timer display for opponent */}
              <div className="timer text-6xl font-bold text-white">
                {opponentDone && opponentTime === null
                  ? 'DNF'
                  : opponentTimer.isRunning || opponentTime !== null
                    ? formatTime(opponentTime ?? opponentTimer.displayTime)
                    : '0.00'}
              </div>
              <p className="text-gray-400 mt-2">
                {!opponentTimer.hasStarted && phase === 'inspecting' && 'Inspecting...'}
                {!opponentTimer.hasStarted && phase === 'solving' && 'Inspecting...'}
                {opponentTimer.hasStarted && !opponentDone && !opponentTime && 'Solving...'}
                {opponentDone && (opponentTime !== null ? 'Done!' : 'DNF')}
              </p>
            </div>
          </div>
        </div>

        {/* Match chat (live opponent) */}
        <div className="card mb-4">
          <div ref={chatListRef} className="max-h-32 overflow-y-auto space-y-1 pr-1 mb-2">
            {matchMessages.length === 0 && (
              <p className="text-gray-600 text-xs">Say gl hf…</p>
            )}
            {matchMessages.map((m, i) => (
              <div key={i} className="text-sm leading-snug">
                <span className={`font-medium mr-1.5 ${m.userId === user.id ? 'text-blue-400' : 'text-gray-200'}`}>
                  {m.username}
                </span>
                <span className="text-gray-300 break-words">{m.text}</span>
              </div>
            ))}
          </div>
          <form onSubmit={submitChat} className="flex gap-2">
            <input
              type="text"
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              maxLength={280}
              placeholder="Chat with your opponent…"
              className="input flex-1 text-sm py-1.5"
            />
            <button type="submit" disabled={!chatDraft.trim()} className="btn btn-secondary px-3 text-sm disabled:opacity-50">
              Send
            </button>
          </form>
        </div>

        {/* Round Result Overlay */}
        {phase === 'round_complete' && (
          <div className="card text-center mb-4">
            <h2 className="text-2xl font-bold mb-2">
              {myTime && opponentTime
                ? myTime < opponentTime
                  ? 'You Win This Round!'
                  : 'Opponent Wins This Round'
                : myTime
                  ? 'You Win This Round!'
                  : opponentTime
                    ? 'Opponent Wins This Round'
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
