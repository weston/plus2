'use client';

import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import type { PuzzleSize } from '@plus2/shared';

export interface TwistyCubeHandle {
  checkSolved: () => Promise<boolean>;
  applyMove: (move: string) => void;
  // How many user moves (prop/imperative, scramble excluded) had committed
  // when the cube most recently became solved — null if never solved.
  // Lets pages trim accidental trailing inputs typed right as a solve ends.
  getSolvedMoveCount: () => number | null;
  // Date.now() when the most recent user move was INPUT (not when its
  // animation committed). Lets a solve stop the clock at move-start so the
  // recorded time excludes the final cosmetic animation. null if no move yet.
  getLastMoveInputAt: () => number | null;
  // True while a move is still animating (input but not yet committed) — the
  // logical cube only reflects a move at animation end, so a solved-check made
  // while a final move is in flight is briefly false.
  hasPendingMoves: () => boolean;
  // Resolve once all in-flight moves have committed (or after a safety
  // timeout), so callers can re-check solved state instead of scoring a DNF.
  settle: (timeoutMs?: number) => Promise<void>;
}

interface TwistyCubeProps {
  puzzleSize: PuzzleSize;
  scramble?: string;
  moves?: string[];
  isInteractive?: boolean;
  onMove?: (move: string) => void;
  onSolved?: () => void; // fired when a move leaves the cube solved (auto-stop timer)
  animationSpeed?: number; // higher = faster
  // Per-face hex colors keyed by U/D/F/B/R/L; omitted faces fall back to the
  // WCA defaults. The cube rebuilds when these change.
  faceColors?: Record<string, string> | null;
  // Image drawn on the U-face center sticker (a real cube's "logo").
  logoUrl?: string | null;
  // Drag to orbit the camera (used by the settings preview).
  draggable?: boolean;
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
  setLogo?: (url: string | null) => void;
  getCommitted?: () => number;
  getSolvedAt?: () => number;
  orbit?: (dTheta: number, dPhi: number) => void;
  setSpeed: (v: number) => void;
  _ro?: ResizeObserver;
}

declare global {
  interface Window {
    makeCstimerCube?: (container: HTMLElement, opts: Record<string, unknown>) => CstimerCube;
  }
}

const SIZE_MAP: Record<PuzzleSize, number> = { '2x2': 2, '3x3': 3, '4x4': 4, '5x5': 5 };

// csTimer's twisty faceColors array order (see twistynnn.js defaults:
// white, red, green, yellow, orange, blue = U, R, F, D, L, B).
const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'] as const;
const DEFAULT_FACE_HEX: Record<string, number> = {
  U: 0xffffff, R: 0xff0000, F: 0x00ff00, D: 0xffff00, L: 0xff9000, B: 0x0000ff,
};

function toFaceColorArray(colors?: Record<string, string> | null): number[] {
  return FACE_ORDER.map((face) => {
    const hex = colors?.[face];
    if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex.slice(1), 16);
    return DEFAULT_FACE_HEX[face];
  });
}

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
  { puzzleSize, scramble = '', moves = [], onSolved, animationSpeed = 3, faceColors, logoUrl, draggable = false, className = '' },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cubeRef = useRef<CstimerCube | null>(null);
  const appliedRef = useRef(0);
  // Committed-move count at the end of build (scramble replay etc.) — the
  // zero point for user-relative move counting.
  const commitBaseRef = useRef(0);
  // Date.now() of the most recent imperative (user) move input — the clock
  // stops here, not at animation commit, so the recorded time doesn't include
  // the final move's cosmetic animation (which varies with animationSpeed).
  const lastMoveInputAtRef = useRef<number | null>(null);
  // Always-current `moves` prop, so the async build can catch up on moves that
  // arrived while the renderer scripts were still loading.
  const movesRef = useRef<string[]>(moves);
  movesRef.current = moves;
  const speedRef = useRef(animationSpeed);
  const onSolvedRef = useRef(onSolved);
  onSolvedRef.current = onSolved;

  const N = SIZE_MAP[puzzleSize] ?? 3;
  const movesSig = moves.join(' ');
  const colorArray = toFaceColorArray(faceColors);
  const colorsSig = colorArray.join(',');
  // Logo changes must not rebuild the cube (that would reset mid-solve) —
  // the glue re-textures the existing sticker in place.
  const logoUrlRef = useRef<string | null>(logoUrl ?? null);
  useEffect(() => {
    logoUrlRef.current = logoUrl ?? null;
    cubeRef.current?.setLogo?.(logoUrl ?? null);
  }, [logoUrl]);

  // Drag-to-orbit (pointer events cover mouse + touch).
  useEffect(() => {
    if (!draggable) return;
    const el = containerRef.current;
    if (!el) return;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const SENS = 0.09; // camera steps per pixel (~180° per 270px drag)

    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
      el.style.cursor = 'grabbing';
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      cubeRef.current?.orbit?.(-dx * SENS, dy * SENS);
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      el.style.cursor = 'grab';
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        /* pointer already released */
      }
    };

    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [draggable]);

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
          faceColors: colorArray,
          logoUrl: logoUrlRef.current || undefined,
          onSolved: () => onSolvedRef.current?.(),
        });
        // Center the square canvas within the container.
        cube.dom.style.display = 'flex';
        cube.dom.style.alignItems = 'center';
        cube.dom.style.justifyContent = 'center';

        appliedRef.current = 0;
        if (scramble) cube.applySeq(scramble, false);
        const built = moves;
        for (const m of built) cube.applyMove(m, false);
        appliedRef.current = built.length;
        commitBaseRef.current = (cube.getCommitted?.() ?? 0) - built.length;

        // Moves that arrived while the renderer scripts were loading aren't in
        // `built` (the moves effect no-ops while cubeRef is null) — reconcile
        // against the latest prop so those inputs aren't silently dropped.
        const latest = movesRef.current;
        if (latest.length < appliedRef.current) {
          cube.reset();
          if (scramble) cube.applySeq(scramble, false);
          for (let i = 0; i < latest.length; i++) cube.applyMove(latest[i], false);
          appliedRef.current = latest.length;
          commitBaseRef.current = (cube.getCommitted?.() ?? 0) - latest.length;
        } else if (latest.length > appliedRef.current) {
          for (let i = appliedRef.current; i < latest.length; i++) cube.applyMove(latest[i], false);
          appliedRef.current = latest.length;
        }

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
  }, [puzzleSize, scramble, colorsSig]);

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
      commitBaseRef.current = (cube.getCommitted?.() ?? 0) - moves.length;
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
      getSolvedMoveCount: () => {
        const cube = cubeRef.current;
        if (!cube?.getSolvedAt) return null;
        const solvedAt = cube.getSolvedAt();
        if (solvedAt < 0) return null;
        const n = solvedAt - commitBaseRef.current;
        return n >= 0 ? n : null;
      },
      getLastMoveInputAt: () => lastMoveInputAtRef.current,
      hasPendingMoves: () => {
        const cube = cubeRef.current;
        if (!cube?.getCommitted) return false;
        // Total moves handed to the renderer (scramble base + user moves) vs
        // how many have committed. A positive delta means a move is animating.
        return commitBaseRef.current + appliedRef.current > cube.getCommitted();
      },
      settle: async (timeoutMs = 700) => {
        const cube = cubeRef.current;
        if (!cube?.getCommitted) return;
        const start = performance.now();
        while (commitBaseRef.current + appliedRef.current > cube.getCommitted()) {
          if (performance.now() - start > timeoutMs) break;
          await new Promise((r) => setTimeout(r, 16));
        }
      },
      applyMove: (move: string) => {
        const cube = cubeRef.current;
        if (!cube) return;
        lastMoveInputAtRef.current = Date.now(); // stop-clock anchor (move-start)
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
