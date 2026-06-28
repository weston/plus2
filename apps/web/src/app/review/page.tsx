'use client';

import { useEffect, useState } from 'react';
import { TwistyCube } from '@/components/TwistyCube';
import type { PuzzleSize } from '@plus2/shared';

const REVIEW_STORAGE_KEY = 'plus2-review';

interface ReviewData {
  puzzleSize: PuzzleSize;
  scramble: string;
  moves: string[];
  timeMs?: number | null;
  title?: string;
}

function formatTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function ReviewPage() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Load the handed-off solve (written to localStorage when "Review" was clicked).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw) as ReviewData;
        if (Array.isArray(d.moves)) {
          setData(d);
          setIndex(d.moves.length); // start at the solved end-state
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Autoplay forward.
  useEffect(() => {
    if (!playing || !data) return;
    if (index >= data.moves.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIndex((i) => Math.min(i + 1, data.moves.length)), 320);
    return () => clearTimeout(t);
  }, [playing, index, data]);

  // Keyboard controls
  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, data.moves.length));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data]);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <p className="text-gray-400 text-center">
          No solve to review. Finish a solve and click <span className="text-white">Review</span>.
        </p>
      </div>
    );
  }

  const total = data.moves.length;
  const movesSoFar = data.moves.slice(0, index);
  const atStart = index <= 0;
  const atEnd = index >= total;

  const btn = 'px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="min-h-screen p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-baseline justify-between mb-4">
          <h1 className="text-2xl font-bold">{data.title || 'Solve Review'}</h1>
          <div className="text-gray-400">
            {data.puzzleSize} · {formatTime(data.timeMs)}
          </div>
        </div>

        <div className="cube-container rounded-lg overflow-hidden">
          <TwistyCube
            puzzleSize={data.puzzleSize}
            scramble={data.scramble}
            moves={movesSoFar}
            animationSpeed={playing ? 6 : 3}
            className="h-80 md:h-[460px]"
          />
        </div>

        {/* Scrubber */}
        <input
          type="range"
          min={0}
          max={total}
          value={index}
          onChange={(e) => {
            setPlaying(false);
            setIndex(parseInt(e.target.value, 10));
          }}
          className="w-full mt-4 accent-blue-500"
        />

        <div className="flex items-center justify-between mt-2 text-sm text-gray-400">
          <span>Move {index} / {total}</span>
          <span className="font-mono text-white">
            {index > 0 ? data.moves[index - 1] : 'scrambled'}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-2 mt-4">
          <button className={btn} onClick={() => { setPlaying(false); setIndex(0); }} disabled={atStart} title="Start">⏮</button>
          <button className={btn} onClick={() => { setPlaying(false); setIndex((i) => Math.max(0, i - 1)); }} disabled={atStart} title="Step back">◀</button>
          <button
            className={`${btn} bg-blue-600 hover:bg-blue-700`}
            onClick={() => {
              if (atEnd) setIndex(0);
              setPlaying((p) => !p);
            }}
            title="Play / pause"
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button className={btn} onClick={() => { setPlaying(false); setIndex((i) => Math.min(total, i + 1)); }} disabled={atEnd} title="Step forward">▶</button>
          <button className={btn} onClick={() => { setPlaying(false); setIndex(total); }} disabled={atEnd} title="End">⏭</button>
        </div>

        <p className="text-center text-xs text-gray-500 mt-4">
          ← / → to step · space to play/pause
        </p>
      </div>
    </div>
  );
}
