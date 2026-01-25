'use client';

import { useEffect, useRef } from 'react';
import type { PuzzleSize } from '@plus2/shared';

interface TwistyCubeProps {
  puzzleSize: PuzzleSize;
  scramble?: string;
  moves?: string[];
  isInteractive?: boolean;
  onMove?: (move: string) => void;
  onSolved?: () => void;
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

export function TwistyCube({
  puzzleSize,
  scramble = '',
  moves = [],
  isInteractive = false,
  onMove,
  onSolved,
  animationSpeed = 3,
  className = '',
}: TwistyCubeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const lastMoveCount = useRef(0);
  const onSolvedRef = useRef(onSolved);
  const animationSpeedRef = useRef(animationSpeed);

  // Keep refs up to date
  useEffect(() => {
    onSolvedRef.current = onSolved;
  }, [onSolved]);

  useEffect(() => {
    animationSpeedRef.current = animationSpeed;
    // Update tempo on existing player
    if (playerRef.current) {
      playerRef.current.tempoScale = animationSpeed;
    }
  }, [animationSpeed]);

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

          // Enable drag input to rotate the cube view
          player.experimentalModel.twistySceneModel.dragInput.set('auto');
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

  // Apply new moves and check for solved state
  useEffect(() => {
    if (!playerRef.current || moves.length === 0) return;

    // Only apply new moves
    const newMoves = moves.slice(lastMoveCount.current);
    if (newMoves.length === 0) return;

    const applyMovesAndCheckSolved = async () => {
      try {
        const { Alg } = await import('cubing/alg');
        const player = playerRef.current;
        const model = player.experimentalModel;

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

        // Wait a bit for animation, then check if solved
        setTimeout(async () => {
          if (model && onSolvedRef.current) {
            try {
              const state = await model.currentPattern.get();
              const puzzle = await model.puzzle.get();
              const solvedState = puzzle.defaultPattern();

              if (state.isIdentical(solvedState)) {
                onSolvedRef.current();
              }
            } catch (e) {
              // Ignore errors during solve check
            }
          }
        }, 100);
      } catch (e) {
        console.error('Failed to apply moves:', e);
      }
    };

    applyMovesAndCheckSolved();
  }, [moves]);

  return (
    <div
      ref={containerRef}
      className={`cube-container ${className}`}
      style={{ minHeight: '400px' }}
    />
  );
}
