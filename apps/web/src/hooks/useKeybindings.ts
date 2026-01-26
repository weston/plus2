'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { DEFAULT_KEYBINDINGS } from '@plus2/shared';

interface UseKeybindingsOptions {
  enabled: boolean;
  onMove: (move: string) => void;
}

export function useKeybindings({ enabled, onMove }: UseKeybindingsOptions) {
  const [bindings, setBindings] = useState<Record<string, string>>(DEFAULT_KEYBINDINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  // Create reverse mapping (key -> move)
  const keyToMove = useRef<Record<string, string>>({});
  // Store callback in ref to avoid re-attaching listener when callback changes
  const onMoveRef = useRef(onMove);

  // Keep ref updated with latest callback
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    // Bindings are key->move format, preserve case for uppercase wide moves
    keyToMove.current = { ...bindings };
  }, [bindings]);

  // Always use default keybindings for now
  useEffect(() => {
    setBindings(DEFAULT_KEYBINDINGS);
    setIsLoaded(true);
  }, []);

  // Handle keydown - only re-attach when enabled/isLoaded changes, not when onMove changes
  useEffect(() => {
    if (!enabled || !isLoaded) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const key = e.key;
      // Try exact key first (for uppercase), then lowercase
      const move = keyToMove.current[key] || keyToMove.current[key.toLowerCase()];

      if (move) {
        e.preventDefault();
        onMoveRef.current(move);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, isLoaded]); // Removed onMove from deps - using ref instead

  return {
    bindings,
    setBindings,
    isLoaded,
  };
}
