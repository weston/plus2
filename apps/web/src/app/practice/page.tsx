'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { TwistyCube } from '@/components/TwistyCube';
import { Timer } from '@/components/Timer';
import { useKeybindings } from '@/hooks/useKeybindings';
import { useAuthStore } from '@/stores/auth';
import type { PuzzleSize } from '@plus2/shared';
import { INSPECTION_DURATION_MS, SCRAMBLE_LENGTHS } from '@plus2/shared';

const PUZZLE_SIZES: PuzzleSize[] = ['2x2', '3x3', '4x4', '5x5'];

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

const ANIMATION_SPEED_KEY = 'plus2_animation_speed';
const DEFAULT_ANIMATION_SPEED = 3;

export default function PracticePage() {
  const { user } = useAuthStore();
  const [puzzleSize, setPuzzleSize] = useState<PuzzleSize>('3x3');
  const [phase, setPhase] = useState<PracticePhase>('idle');
  const [scramble, setScramble] = useState('');
  const [moves, setMoves] = useState<string[]>([]);
  const [inspectionStart, setInspectionStart] = useState<number | null>(null);
  const [solveStart, setSolveStart] = useState<number | null>(null);
  const [solveTime, setSolveTime] = useState<number | null>(null);
  const [times, setTimes] = useState<SolveTime[]>([]);
  const [animationSpeed, setAnimationSpeed] = useState(DEFAULT_ANIMATION_SPEED);

  const moveSeqRef = useRef(0);
  const inspectionTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Load animation speed from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(ANIMATION_SPEED_KEY);
    if (saved) {
      setAnimationSpeed(parseFloat(saved));
    }
  }, []);

  // Save animation speed to localStorage
  const handleAnimationSpeedChange = (speed: number) => {
    setAnimationSpeed(speed);
    localStorage.setItem(ANIMATION_SPEED_KEY, speed.toString());
  };

  // Generate new scramble
  const newScramble = useCallback(() => {
    setScramble(generateScramble(puzzleSize));
    setMoves([]);
    setSolveTime(null);
    setPhase('idle');
    moveSeqRef.current = 0;
  }, [puzzleSize]);

  // Initialize with a scramble
  useEffect(() => {
    newScramble();
  }, [puzzleSize]);

  // Start inspection
  const startInspection = useCallback(() => {
    if (phase !== 'idle') return;
    setPhase('inspecting');
    setInspectionStart(Date.now());

    // Auto-start solve after inspection ends
    inspectionTimerRef.current = setTimeout(() => {
      setPhase('solving');
      setSolveStart(Date.now());
    }, INSPECTION_DURATION_MS);
  }, [phase]);

  // Check if move is a rotation (doesn't start timer)
  const isRotation = (move: string) => {
    return move.startsWith('x') || move.startsWith('y') || move.startsWith('z');
  };

  // Handle move
  const handleMove = useCallback((move: string) => {
    const rotation = isRotation(move);

    if (phase === 'idle') {
      // Rotations during idle just rotate the cube, don't start timer
      if (rotation) {
        setMoves(prev => [...prev, move]);
        return;
      }
      // First actual move starts solving immediately (skip inspection for practice mode)
      if (inspectionTimerRef.current) {
        clearTimeout(inspectionTimerRef.current);
      }
      setPhase('solving');
      setSolveStart(Date.now());
      moveSeqRef.current = 1;
      setMoves(prev => [...prev, move]);
      return;
    }

    if (phase === 'inspecting') {
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
      setSolveStart(Date.now());
    }

    if (phase === 'inspecting' || phase === 'solving') {
      moveSeqRef.current += 1;
      setMoves(prev => [...prev, move]);
    }
  }, [phase, startInspection]);

  // Stop timer (called when cube is solved or manually)
  const stopTimer = useCallback((finalMoveCount?: number) => {
    if (phase !== 'solving' || !solveStart) return;

    const time = Date.now() - solveStart;
    setSolveTime(time);
    setPhase('done');

    // Record the solve
    const newTime: SolveTime = {
      time,
      scramble,
      moveCount: finalMoveCount ?? moves.length,
      timestamp: new Date(),
    };
    setTimes(prev => [...prev, newTime]);
  }, [phase, solveStart, scramble, moves.length]);

  // Called when cube is solved (auto-detected)
  const handleSolved = useCallback(() => {
    stopTimer(moves.length);
  }, [stopTimer, moves.length]);

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

      if (e.code === 'Space') {
        e.preventDefault();

        if (phase === 'idle') {
          startInspection();
        } else if (phase === 'solving') {
          stopTimer();
        } else if (phase === 'done') {
          newScramble();
        }
      }

      if (e.code === 'Escape') {
        e.preventDefault();
        if (phase === 'inspecting' || phase === 'solving') {
          // Cancel current solve
          if (inspectionTimerRef.current) {
            clearTimeout(inspectionTimerRef.current);
          }
          setPhase('idle');
          setInspectionStart(null);
          setSolveStart(null);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase, startInspection, stopTimer, newScramble]);

  // Use keybindings for cube moves
  useKeybindings({
    enabled: phase === 'idle' || phase === 'inspecting' || phase === 'solving',
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

          {/* Puzzle Size Selector */}
          <div className="flex gap-2">
            {PUZZLE_SIZES.map((size) => (
              <button
                key={size}
                onClick={() => setPuzzleSize(size)}
                disabled={phase !== 'idle' && phase !== 'done'}
                className={`px-3 py-1 rounded-lg font-medium transition-all ${
                  puzzleSize === size
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                } disabled:opacity-50`}
              >
                {size}
              </button>
            ))}
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
                    {phase === 'idle' && 'Press SPACE to start inspection, or make a move'}
                    {phase === 'inspecting' && 'Inspecting... Make a move to start timer'}
                    {phase === 'solving' && 'Solving... Timer stops when cube is solved'}
                    {phase === 'done' && 'Press SPACE for next scramble'}
                  </p>
                </div>

                {/* Cube visualization */}
                <div className="w-full max-w-md">
                  <TwistyCube
                    puzzleSize={puzzleSize}
                    scramble={scramble}
                    moves={moves}
                    onSolved={handleSolved}
                    animationSpeed={animationSpeed}
                    className="h-48 md:h-64"
                  />
                </div>

                {/* Move count */}
                {moves.length > 0 && (
                  <p className="text-gray-400 mt-4">
                    Moves: {moves.length}
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

            {/* Animation Speed */}
            <div className="card">
              <h3 className="text-lg font-semibold mb-3">Animation Speed</h3>
              <div className="space-y-3">
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={animationSpeed}
                  onChange={(e) => handleAnimationSpeedChange(parseFloat(e.target.value))}
                  className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-xs text-gray-400">
                  <span>Instant</span>
                  <span className="text-white font-medium">
                    {animationSpeed === 0 ? 'Instant' : `${animationSpeed}x`}
                  </span>
                  <span>Fast</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
