'use client';

import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import type { PuzzleSize } from '@plus2/shared';

export interface TwistyCubeHandle {
  checkSolved: () => Promise<boolean>;
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

export const TwistyCube = forwardRef<TwistyCubeHandle, TwistyCubeProps>(function TwistyCube({
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

  // Expose checkSolved method to parent components
  useImperativeHandle(ref, () => ({
    checkSolved: async () => {
      try {
        const player = playerRef.current;
        if (!player) return false;

        const { Alg } = await import('cubing/alg');

        // Get current state from the player
        const currentPattern = await player.experimentalModel.currentPattern.get();

        // Get the puzzle and its solved state
        const { puzzles } = await import('cubing/puzzles');
        const kpuzzle = await puzzles[puzzleMap[puzzleSize]].kpuzzle();
        const solvedState = kpuzzle.defaultPattern();

        // All 24 possible cube orientations
        const orientations = [
          '', 'x', 'x2', "x'",
          'y', 'y x', 'y x2', "y x'",
          'y2', 'y2 x', 'y2 x2', "y2 x'",
          "y'", "y' x", "y' x2", "y' x'",
          'z', 'z x', 'z x2', "z x'",
          "z'", "z' x", "z' x2", "z' x'"
        ];

        // Check if current pattern matches solved state in any orientation
        for (const orient of orientations) {
          const rotatedSolved = orient
            ? solvedState.applyAlg(new Alg(orient))
            : solvedState;

          if (currentPattern.isIdentical(rotatedSolved)) {
            return true;
          }
        }
        return false;
      } catch (e) {
        console.error('Solve check error:', e);
        return false;
      }
    }
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
        const { Alg } = await import('cubing/alg');
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
