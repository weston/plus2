'use client';

import { useEffect, useRef, useImperativeHandle, forwardRef, memo } from 'react';
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
  animationSpeed?: number; // 1 = normal, higher = faster, 0 = instant
  className?: string;
}

// Map puzzle size to cubing.js puzzle type
type CubingPuzzle = '2x2x2' | '3x3x3' | '4x4x4' | '5x5x5';
const puzzleMap: Record<PuzzleSize, CubingPuzzle> = {
  '2x2': '2x2x2',
  '3x3': '3x3x3',
  '4x4': '4x4x4',
  '5x5': '5x5x5',
};

// All 24 possible cube orientations
const ORIENTATIONS = [
  '', 'x', 'x2', "x'",
  'y', 'y x', 'y x2', "y x'",
  'y2', 'y2 x', 'y2 x2', "y2 x'",
  "y'", "y' x", "y' x2", "y' x'",
  'z', 'z x', 'z x2', "z x'",
  "z'", "z' x", "z' x2", "z' x'"
];

// Cache for pre-computed solved patterns per puzzle size
const solvedPatternsCache = new Map<PuzzleSize, any[]>();
// Cache for loaded modules
let algModule: any = null;
let puzzlesModule: any = null;

// Pre-compute solved patterns for a puzzle size
async function getSolvedPatterns(puzzleSize: PuzzleSize): Promise<any[]> {
  const cached = solvedPatternsCache.get(puzzleSize);
  if (cached) return cached;

  // Load modules once
  if (!algModule) {
    algModule = await import('cubing/alg');
  }
  if (!puzzlesModule) {
    puzzlesModule = await import('cubing/puzzles');
  }

  const { Alg } = algModule;
  const { puzzles } = puzzlesModule;

  const kpuzzle = await puzzles[puzzleMap[puzzleSize]].kpuzzle();
  const solvedState = kpuzzle.defaultPattern();

  // Pre-compute all 24 rotated solved patterns
  const patterns = ORIENTATIONS.map(orient =>
    orient ? solvedState.applyAlg(new Alg(orient)) : solvedState
  );

  solvedPatternsCache.set(puzzleSize, patterns);
  return patterns;
}

const TwistyCubeInner = forwardRef<TwistyCubeHandle, TwistyCubeProps>(function TwistyCube({
  puzzleSize,
  scramble = '',
  moves = [],
  isInteractive = false,
  onMove,
  animationSpeed = 3,
  className = '',
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const lastMoveCount = useRef(0);
  const animationSpeedRef = useRef(animationSpeed);

  useEffect(() => {
    animationSpeedRef.current = animationSpeed;
    // Update tempo on existing player
    if (playerRef.current) {
      playerRef.current.tempoScale = animationSpeed;
    }
  }, [animationSpeed]);

  // Imperative method to apply a single move (avoids re-renders)
  const applyMoveImperative = async (moveStr: string) => {
    try {
      const player = playerRef.current;
      if (!player) return;

      if (!algModule) {
        algModule = await import('cubing/alg');
      }
      const { Alg } = algModule;
      const alg = new Alg(moveStr);
      for (const move of alg.units()) {
        player.experimentalAddMove(move);
        break;
      }
      // Increment lastMoveCount so useEffect doesn't re-apply this move
      lastMoveCount.current += 1;
    } catch (e) {
      console.error('Failed to apply move:', e);
    }
  };

  // Expose methods to parent components
  useImperativeHandle(ref, () => ({
    checkSolved: async () => {
      try {
        const player = playerRef.current;
        if (!player) return false;

        // Get current state from the player
        const currentPattern = await player.experimentalModel.currentPattern.get();

        // Get pre-computed solved patterns (cached after first call)
        const solvedPatterns = await getSolvedPatterns(puzzleSize);

        // Check if current pattern matches any of the 24 solved orientations
        for (const rotatedSolved of solvedPatterns) {
          if (currentPattern.isIdentical(rotatedSolved)) {
            return true;
          }
        }
        return false;
      } catch (e) {
        console.error('Solve check error:', e);
        return false;
      }
    },
    applyMove: applyMoveImperative,
  }), [puzzleSize]);

  // Initialize cube
  useEffect(() => {
    if (!containerRef.current) return;

    // Dynamic import of cubing.js
    import('cubing/twisty').then(({ TwistyPlayer }) => {
      // Clear previous player
      if (playerRef.current) {
        playerRef.current.remove();
      }
      containerRef.current!.innerHTML = '';

      const player = new TwistyPlayer({
        puzzle: puzzleMap[puzzleSize],
        experimentalSetupAlg: scramble, // Setup alg doesn't animate
        alg: '', // Start with empty alg for moves
        hintFacelets: 'floating',
        backView: 'none',
        background: 'none',
        controlPanel: 'none',
        visualization: '3D',
        tempoScale: animationSpeedRef.current,
        experimentalStickering: 'full',
      } as any);



      player.style.width = '100%';
      player.style.height = '100%';

      containerRef.current!.appendChild(player);
      playerRef.current = player;
      lastMoveCount.current = 0;

      // Pre-warm the solved patterns cache in the background
      getSolvedPatterns(puzzleSize);

      // Set camera position and enable drag after player is fully ready
      (async () => {
        try {
          // Wait for the scene to be ready
          await player.experimentalModel.twistySceneModel.orbitCoordinates.get();

          // Set camera position - front face with top visible
          player.experimentalModel.twistySceneModel.orbitCoordinatesRequest.set({
            latitude: 35,
            longitude: 1,
            distance: 6,
          });

          // Disable drag input - cube orientation must be fixed
          player.experimentalModel.twistySceneModel.dragInput.set('none');
        } catch (e) {
          // Camera setup failed, use defaults
        }
      })();
    });

    return () => {
      if (playerRef.current) {
        playerRef.current.remove();
        playerRef.current = null;
      }
    };
  }, [puzzleSize, scramble]);

  // Apply new moves (solve checking is done on demand via ref)
  useEffect(() => {
    if (!playerRef.current || moves.length === 0) return;

    // Only apply new moves
    const newMoves = moves.slice(lastMoveCount.current);
    if (newMoves.length === 0) return;

    const applyMoves = async () => {
      try {
        // Use cached module if available, otherwise load it
        if (!algModule) {
          algModule = await import('cubing/alg');
        }
        const { Alg } = algModule;
        const player = playerRef.current;

        // Add each move with animation
        for (const moveStr of newMoves) {
          const alg = new Alg(moveStr);
          // Get the first unit from the alg (it's an iterable)
          for (const move of alg.units()) {
            player.experimentalAddMove(move);
            break; // Only take the first move
          }
        }
        lastMoveCount.current = moves.length;
      } catch (e) {
        console.error('Failed to apply moves:', e);
      }
    };

    applyMoves();
  }, [moves]);

  return (
    <div
      ref={containerRef}
      className={`cube-container ${className}`}
      style={{ minHeight: '400px' }}
    />
  );
});

// Memoize to prevent re-renders when moves array reference changes but content is same
export const TwistyCube = memo(TwistyCubeInner, (prevProps, nextProps) => {
  // Only re-render if these props actually change
  if (prevProps.puzzleSize !== nextProps.puzzleSize) return false;
  if (prevProps.scramble !== nextProps.scramble) return false;
  if (prevProps.animationSpeed !== nextProps.animationSpeed) return false;
  if (prevProps.className !== nextProps.className) return false;
  if (prevProps.isInteractive !== nextProps.isInteractive) return false;
  // For moves, compare length - the component handles incremental updates internally
  if (prevProps.moves?.length !== nextProps.moves?.length) return false;
  return true;
});
