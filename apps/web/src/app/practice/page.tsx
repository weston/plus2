'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { TwistyCube, TwistyCubeHandle } from '@/components/TwistyCube';
import { Timer } from '@/components/Timer';
import { useKeybindings } from '@/hooks/useKeybindings';
import { useAuthStore } from '@/stores/auth';
import { useCubePrefs } from '@/stores/cubePrefs';
import { usersApi } from '@/lib/api';
import type { PuzzleSize } from '@plus2/shared';
import { INSPECTION_DURATION_MS, SCRAMBLE_LENGTHS } from '@plus2/shared';

const PUZZLE_SIZES: PuzzleSize[] = ['3x3']; // Only 3x3 for now

type PracticePhase = 'idle' | 'inspecting' | 'solving' | 'done';

interface SolveTime {
  time: number;
  scramble: string;
  moveCount: number;
  timestamp: Date;
  dnf?: boolean;
}

// Simple scramble generator
function generateScramble(puzzleSize: PuzzleSize): string {
  const moves = ['R', 'L', 'U', 'D', 'F', 'B'];
  const modifiers = ['', "'", '2'];
  const length = SCRAMBLE_LENGTHS[puzzleSize];

  const scramble: string[] = [];
  let lastMove = '';
  let secondLastMove = '';

  const isOpposite = (m1: string, m2: string) => {
    const opposites: Record<string, string> = { R: 'L', L: 'R', U: 'D', D: 'U', F: 'B', B: 'F' };
    return opposites[m1] === m2;
  };

  for (let i = 0; i < length; i++) {
    let move: string;
    do {
      move = moves[Math.floor(Math.random() * moves.length)];
    } while (move === lastMove || (move === secondLastMove && isOpposite(move, lastMove)));

    const modifier = modifiers[Math.floor(Math.random() * modifiers.length)];
    scramble.push(move + modifier);
    secondLastMove = lastMove;
    lastMove = move;
  }

  return scramble.join(' ');
}

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

function calculateAo5(times: SolveTime[]): number | null {
  if (times.length < 5) return null;
  const last5 = times.slice(-5).map(t => t.dnf ? Infinity : t.time);
  last5.sort((a, b) => a - b);
  // Remove best and worst
  const middle3 = last5.slice(1, 4);
  if (middle3.some(t => t === Infinity)) return null;
  return Math.round(middle3.reduce((a, b) => a + b, 0) / 3);
}

function calculateAo12(times: SolveTime[]): number | null {
  if (times.length < 12) return null;
  const last12 = times.slice(-12).map(t => t.dnf ? Infinity : t.time);
  last12.sort((a, b) => a - b);
  // Remove best and worst
  const middle10 = last12.slice(1, 11);
  if (middle10.some(t => t === Infinity)) return null;
  return Math.round(middle10.reduce((a, b) => a + b, 0) / 10);
}

const DEFAULT_ANIMATION_SPEED = 3;

export default function PracticePage() {
  const myCubeColors = useCubePrefs((st) => st.colors);
  const { user, accessToken } = useAuthStore();
  const [puzzleSize, setPuzzleSize] = useState<PuzzleSize>('3x3');
  const [phase, setPhase] = useState<PracticePhase>('idle');
  const [scramble, setScramble] = useState(''); // The scramble text to display
  const [appliedScramble, setAppliedScramble] = useState(''); // Scramble applied to cube (empty until inspection)
  const [moves, setMoves] = useState<string[]>([]);
  const [inspectionStart, setInspectionStart] = useState<number | null>(null);
  const [solveStart, setSolveStart] = useState<number | null>(null);
  const [solveTime, setSolveTime] = useState<number | null>(null);
  const [times, setTimes] = useState<SolveTime[]>([]);
  const [animationSpeed, setAnimationSpeed] = useState(DEFAULT_ANIMATION_SPEED);

  const moveSeqRef = useRef(0);
  const inspectionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const phaseRef = useRef<PracticePhase>('idle'); // Ref for current phase to avoid closure issues
  const cubeRef = useRef<TwistyCubeHandle>(null);

  // Load animation speed from server preferences
  useEffect(() => {
    if (!accessToken) return;
    usersApi.getPreferences(accessToken).then((prefs) => {
      if (prefs.animationSpeed !== undefined) {
        setAnimationSpeed(prefs.animationSpeed);
      }
    }).catch(() => {
      // Use default if failed to load
    });
  }, [accessToken]);

  // Keep phaseRef in sync with phase state
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Generate new scramble (but don't apply it to cube yet)
  const newScramble = useCallback(() => {
    setScramble(generateScramble(puzzleSize));
    setAppliedScramble(''); // Cube stays solved until inspection
    setMoves([]);
    setSolveTime(null);
    setPhase('idle');
    phaseRef.current = 'idle';
    moveSeqRef.current = 0;
  }, [puzzleSize]);

  // Initialize with a scramble
  useEffect(() => {
    newScramble();
  }, [puzzleSize]);

  // Start inspection - scrambles the cube and shows it
  const startInspection = useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    setAppliedScramble(scramble); // Apply scramble to cube now
    setPhase('inspecting');
    phaseRef.current = 'inspecting';
    setInspectionStart(Date.now());

    // Auto-start solve after inspection ends
    inspectionTimerRef.current = setTimeout(() => {
      setPhase('solving');
      phaseRef.current = 'solving';
      setSolveStart(Date.now());
    }, INSPECTION_DURATION_MS);
  }, [scramble]);

  // Check if move is a rotation (doesn't start timer)
  const isRotation = (move: string) => {
    return move.startsWith('x') || move.startsWith('y') || move.startsWith('z');
  };

  // Handle move
  const handleMove = useCallback((move: string) => {
    const rotation = isRotation(move);
    const currentPhase = phaseRef.current;

    if (currentPhase === 'inspecting') {
      // Apply move immediately for instant visual feedback
      cubeRef.current?.applyMove(move);
      // Rotations during inspection don't start the solve
      if (rotation) {
        setMoves(prev => [...prev, move]);
        return;
      }
      // First actual move during inspection starts the solve
      if (inspectionTimerRef.current) {
        clearTimeout(inspectionTimerRef.current);
      }
      setPhase('solving');
      phaseRef.current = 'solving';
      setSolveStart(Date.now());
      setMoves(prev => [...prev, move]);
      moveSeqRef.current = 1;
      return;
    }

    if (currentPhase === 'solving') {
      // Apply move immediately for instant visual feedback
      cubeRef.current?.applyMove(move);
      moveSeqRef.current += 1;
      setMoves(prev => [...prev, move]);
    }
  }, []);

  // Count non-rotation moves
  const countNonRotationMoves = useCallback((moveList: string[]) => {
    return moveList.filter(m => !isRotation(m)).length;
  }, []);

  // Stop timer - checks if cube is solved and records the time
  const stopTimer = useCallback(async () => {
    // Use phaseRef to get CURRENT phase (not stale closure value)
    if (phaseRef.current !== 'solving' || !solveStart) return;

    const time = Date.now() - solveStart;

    // Check if cube is solved
    const isSolved = await cubeRef.current?.checkSolved() ?? false;

    setSolveTime(time);
    setPhase('done');
    phaseRef.current = 'done';

    // Record the solve - DNF if not solved
    const newTime: SolveTime = {
      time,
      scramble,
      moveCount: countNonRotationMoves(moves),
      timestamp: new Date(),
      dnf: !isSolved,
    };
    setTimes(prev => [...prev, newTime]);
  }, [solveStart, scramble, moves, countNonRotationMoves]);

  // Mark last solve as DNF
  const markDNF = useCallback(() => {
    if (times.length === 0) return;
    setTimes(prev => {
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1], dnf: true };
      return updated;
    });
  }, [times.length]);

  // Delete last solve
  const deleteLast = useCallback(() => {
    setTimes(prev => prev.slice(0, -1));
  }, []);

  // Clear all times
  const clearTimes = useCallback(() => {
    if (confirm('Clear all times?')) {
      setTimes([]);
    }
  }, []);

  // Keyboard handling for spacebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const currentPhase = phaseRef.current;

      if (e.code === 'Space') {
        e.preventDefault();

        if (currentPhase === 'idle') {
          startInspection();
        } else if (currentPhase === 'solving') {
          stopTimer(); // Will check if cube is solved
        } else if (currentPhase === 'done') {
          // Generate new scramble and immediately start inspection
          const newScrambleStr = generateScramble(puzzleSize);
          setScramble(newScrambleStr);
          setAppliedScramble(newScrambleStr);
          setMoves([]);
          setSolveTime(null);
          moveSeqRef.current = 0;
          setPhase('inspecting');
          phaseRef.current = 'inspecting';
          setInspectionStart(Date.now());

          // Auto-start solve after inspection ends
          inspectionTimerRef.current = setTimeout(() => {
            setPhase('solving');
            phaseRef.current = 'solving';
            setSolveStart(Date.now());
          }, INSPECTION_DURATION_MS);
        }
      }

      if (e.code === 'Escape') {
        e.preventDefault();
        if (currentPhase === 'inspecting' || currentPhase === 'solving') {
          // Cancel current solve
          if (inspectionTimerRef.current) {
            clearTimeout(inspectionTimerRef.current);
          }
          setPhase('idle');
          phaseRef.current = 'idle';
          setInspectionStart(null);
          setSolveStart(null);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [startInspection, stopTimer, newScramble]);

  // Use keybindings for cube moves (not during idle since cube is hidden)
  useKeybindings({
    enabled: phase === 'inspecting' || phase === 'solving',
    onMove: handleMove,
  });

  // Stats calculations
  const validTimes = times.filter(t => !t.dnf);
  const bestTime = validTimes.length > 0
    ? Math.min(...validTimes.map(t => t.time))
    : null;
  const ao5 = calculateAo5(times);
  const ao12 = calculateAo12(times);

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-4">
            <Link href={user ? '/dashboard' : '/'} className="text-gray-400 hover:text-white">
              ← Back
            </Link>
            <h1 className="text-2xl font-bold">Practice Mode</h1>
          </div>

          {/* Puzzle type badge */}
          <div className="px-3 py-1 rounded-lg bg-blue-600 text-white font-medium">
            3x3
          </div>
        </header>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Main Practice Area */}
          <div className="lg:col-span-2 space-y-4">
            {/* Scramble */}
            <div className="card">
              <div className="flex justify-between items-start mb-2">
                <span className="text-gray-400 text-sm">Scramble</span>
                <button
                  onClick={newScramble}
                  disabled={phase === 'inspecting' || phase === 'solving'}
                  className="text-sm text-blue-500 hover:text-blue-400 disabled:opacity-50"
                >
                  New Scramble
                </button>
              </div>
              <p className="scramble-text text-lg md:text-xl leading-relaxed">{scramble}</p>
            </div>

            {/* Cube + Timer */}
            <div className="card">
              <div className="flex flex-col items-center">
                {/* Timer */}
                <div className="mb-6 text-center">
                  {phase === 'idle' && (
                    <div className="text-6xl md:text-8xl font-bold timer text-gray-500">
                      0.00
                    </div>
                  )}
                  {phase === 'inspecting' && (
                    <Timer
                      startTime={inspectionStart}
                      isRunning={true}
                      isInspection={true}
                      inspectionDuration={INSPECTION_DURATION_MS}
                    />
                  )}
                  {phase === 'solving' && (
                    <Timer
                      startTime={solveStart}
                      isRunning={true}
                    />
                  )}
                  {phase === 'done' && solveTime !== null && (
                    <div className="text-6xl md:text-8xl font-bold timer text-green-500">
                      {formatTime(solveTime)}
                    </div>
                  )}

                  <p className="text-gray-400 mt-4 text-sm md:text-base">
                    {phase === 'idle' && 'Press SPACE to scramble and start inspection'}
                    {phase === 'inspecting' && 'Inspecting... Make a move to start timer'}
                    {phase === 'solving' && 'Solving... Timer stops when cube is solved'}
                    {phase === 'done' && 'Press SPACE for next scramble'}
                  </p>
                </div>

                {/* Cube visualization - always visible */}
                <div className="w-full max-w-2xl mx-auto">
                  <TwistyCube
                    ref={cubeRef}
                    puzzleSize={puzzleSize}
                    scramble={appliedScramble}
                    moves={moves}
                    onSolved={stopTimer}
                    animationSpeed={animationSpeed}
                    faceColors={myCubeColors}
                    className="h-80 md:h-[500px]"
                  />
                </div>

                {/* Move count - excludes rotations */}
                {countNonRotationMoves(moves) > 0 && (
                  <p className="text-gray-400 mt-4">
                    Moves: {countNonRotationMoves(moves)}
                  </p>
                )}
              </div>
            </div>

            {/* Last solve controls */}
            {phase === 'done' && times.length > 0 && (
              <div className="card">
                <div className="flex flex-wrap gap-2 justify-center">
                  <button
                    onClick={markDNF}
                    className={`btn ${times[times.length - 1]?.dnf ? 'btn-danger' : 'btn-secondary'}`}
                  >
                    DNF
                  </button>
                  <button onClick={deleteLast} className="btn btn-secondary">
                    Delete
                  </button>
                  <button
                    onClick={() => {
                      try {
                        localStorage.setItem(
                          'plus2-review',
                          JSON.stringify({
                            puzzleSize,
                            scramble: appliedScramble,
                            moves,
                            timeMs: solveTime,
                            title: 'Practice Solve',
                          }),
                        );
                        window.open('/review', '_blank');
                      } catch {
                        /* ignore */
                      }
                    }}
                    className="btn btn-secondary"
                  >
                    Review
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Stats & Times Panel */}
          <div className="space-y-4">
            {/* Session Stats */}
            <div className="card">
              <h3 className="text-lg font-semibold mb-4">Session Stats</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-400">Solves</span>
                  <p className="text-xl font-bold">{times.length}</p>
                </div>
                <div>
                  <span className="text-gray-400">Best</span>
                  <p className="text-xl font-bold text-green-500">
                    {bestTime ? formatTime(bestTime) : '-'}
                  </p>
                </div>
                <div>
                  <span className="text-gray-400">Ao5</span>
                  <p className="text-xl font-bold">
                    {ao5 ? formatTime(ao5) : '-'}
                  </p>
                </div>
                <div>
                  <span className="text-gray-400">Ao12</span>
                  <p className="text-xl font-bold">
                    {ao12 ? formatTime(ao12) : '-'}
                  </p>
                </div>
              </div>
            </div>

            {/* Times List */}
            <div className="card">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold">Times</h3>
                {times.length > 0 && (
                  <button
                    onClick={clearTimes}
                    className="text-sm text-red-500 hover:text-red-400"
                  >
                    Clear All
                  </button>
                )}
              </div>

              {times.length === 0 ? (
                <p className="text-gray-400 text-sm">No solves yet</p>
              ) : (
                <div className="max-h-96 overflow-y-auto space-y-1">
                  {times.slice().reverse().map((t, i) => {
                    const realIndex = times.length - 1 - i;
                    return (
                      <div
                        key={realIndex}
                        className="flex justify-between items-center py-1 px-2 rounded hover:bg-gray-800/50 text-sm"
                      >
                        <span className="text-gray-500 w-8">{realIndex + 1}.</span>
                        <span className={`font-mono ${t.dnf ? 'text-red-500' : ''}`}>
                          {t.dnf ? 'DNF' : formatTime(t.time)}
                        </span>
                        <span className="text-gray-500 text-xs">
                          {t.moveCount} moves
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Keyboard shortcuts */}
            <div className="card">
              <h3 className="text-lg font-semibold mb-3">Controls</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Start inspection</span>
                  <kbd className="key-badge">Space</kbd>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Next scramble</span>
                  <kbd className="key-badge">Space</kbd>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Cancel</span>
                  <kbd className="key-badge">Esc</kbd>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Cube moves</span>
                  <span className="text-gray-500">Your keybindings</span>
                </div>
                <p className="text-gray-500 text-xs mt-2">
                  Timer auto-stops when cube is solved
                </p>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
