'use client';

import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import type { PuzzleSize } from '@plus2/shared';

export interface TwistyCubeHandle {
  checkSolved: () => Promise<boolean>;
  applyMove: (move: string) => void;
}

interface TwistyCubeProps {
  puzzleSize: PuzzleSize;
  scramble?: string;
  moves?: string[];
  isInteractive?: boolean;
  onMove?: (move: string) => void;
  onSolved?: () => void; // fired when a move leaves the cube solved (auto-stop timer)
  animationSpeed?: number; // higher = faster
  className?: string;
}

interface CstimerCube {
  scene: { getTwisty: () => unknown };
  dom: HTMLElement;
  applyMove: (token: string, animate: boolean) => void;
  applySeq: (seq: string, animate: boolean) => void;
  getFacelet: () => string;
  isSolved: () => boolean;
  resize: () => void;
  reset: () => void;
  setSpeed: (v: number) => void;
  _ro?: ResizeObserver;
}

declare global {
  interface Window {
    makeCstimerCube?: (container: HTMLElement, opts: Record<string, unknown>) => CstimerCube;
  }
}

const SIZE_MAP: Record<PuzzleSize, number> = { '2x2': 2, '3x3': 3, '4x4': 4, '5x5': 5 };

// Vendored csTimer renderer scripts (GPL-3.0 — see public/cstimer/NOTICE).
// Order matters: libs, then twisty, then the cube plugin, then our glue.
const SCRIPTS = [
  '/cstimer/threemin.js',
  '/cstimer/pnltri.js',
  '/cstimer/twisty.js',
  '/cstimer/twistynnn.js',
  '/cstimer/cube-glue.js',
];

// csTimer camera orientation ("theta+6,phi+6"): straight-on (azimuth 0), top
// tilted well back. Matches the reference: front face dead-on, symmetric side slivers.
const ORI = '6,11';

// Canvas size as a fraction of the container — leaves dark background margin around the cube.
const FIT = 0.82;

let loadPromise: Promise<void> | null = null;
function loadCstimer(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.makeCstimerCube) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = SCRIPTS.reduce(
    (p, src) =>
      p.then(
        () =>
          new Promise<void>((resolve, reject) => {
            const existing = document.querySelector<HTMLScriptElement>(`script[data-cst="${src}"]`);
            if (existing) {
              if (existing.dataset.loaded) return resolve();
              existing.addEventListener('load', () => resolve());
              existing.addEventListener('error', () => reject(new Error(`load ${src}`)));
              return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.async = false;
            s.dataset.cst = src;
            s.addEventListener('load', () => {
              s.dataset.loaded = '1';
              resolve();
            });
            s.addEventListener('error', () => reject(new Error(`load ${src}`)));
            document.head.appendChild(s);
          }),
      ),
    Promise.resolve(),
  );
  return loadPromise;
}

function speedToVrc(speed: number): number {
  const s = Math.min(12, Math.max(0.5, speed || 1));
  return Math.min(1000, Math.max(30, Math.round(330 / s)));
}

export const TwistyCube = forwardRef<TwistyCubeHandle, TwistyCubeProps>(function TwistyCube(
  { puzzleSize, scramble = '', moves = [], onSolved, animationSpeed = 3, className = '' },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cubeRef = useRef<CstimerCube | null>(null);
  const appliedRef = useRef(0);
  const speedRef = useRef(animationSpeed);
  const onSolvedRef = useRef(onSolved);
  onSolvedRef.current = onSolved;

  const N = SIZE_MAP[puzzleSize] ?? 3;
  const movesSig = moves.join(' ');

  useEffect(() => {
    speedRef.current = animationSpeed;
    cubeRef.current?.setSpeed(speedToVrc(animationSpeed));
  }, [animationSpeed]);

  // Build (or rebuild) the cube on size/scramble change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;

    loadCstimer()
      .then(() => {
        if (cancelled || !container || !window.makeCstimerCube) return;
        container.innerHTML = '';
        const cube = window.makeCstimerCube(container, {
          dimension: N,
          speed: speedToVrc(speedRef.current),
          ori: ORI,
          fit: FIT,
          onSolved: () => onSolvedRef.current?.(),
        });
        // Center the square canvas within the container.
        cube.dom.style.display = 'flex';
        cube.dom.style.alignItems = 'center';
        cube.dom.style.justifyContent = 'center';

        appliedRef.current = 0;
        if (scramble) cube.applySeq(scramble, false);
        for (const m of moves) cube.applyMove(m, false);
        appliedRef.current = moves.length;

        cube.resize();
        const ro = new ResizeObserver(() => cube.resize());
        ro.observe(container);
        cube._ro = ro;
        cubeRef.current = cube;
      })
      .catch(() => {
        /* script load failed; nothing rendered */
      });

    return () => {
      cancelled = true;
      cubeRef.current?._ro?.disconnect();
      cubeRef.current = null;
      if (container) container.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puzzleSize, scramble]);

  // React to the declarative `moves` prop (opponent / replay / ghost).
  useEffect(() => {
    const cube = cubeRef.current;
    if (!cube) return;

    if (moves.length < appliedRef.current) {
      // Rewind: reset to solved, replay scramble + remaining moves instantly.
      cube.reset();
      if (scramble) cube.applySeq(scramble, false);
      for (let i = 0; i < moves.length; i++) cube.applyMove(moves[i], false);
      appliedRef.current = moves.length;
    } else if (moves.length > appliedRef.current) {
      // New moves to play forward (interactive cubes already advanced via applyMove).
      for (let i = appliedRef.current; i < moves.length; i++) cube.applyMove(moves[i], true);
      appliedRef.current = moves.length;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movesSig]);

  useImperativeHandle(
    ref,
    () => ({
      checkSolved: async () => (cubeRef.current ? cubeRef.current.isSolved() : false),
      applyMove: (move: string) => {
        const cube = cubeRef.current;
        if (!cube) return;
        appliedRef.current += 1; // keep the moves effect from replaying this move
        cube.applyMove(move, true);
      },
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className={`cube-container ${className}`}
      style={{ position: 'relative', width: '100%' }}
    />
  );
});
