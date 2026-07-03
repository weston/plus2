'use client';

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_KEYBINDINGS } from '@plus2/shared';
import { keybindingsApi } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';

interface UseKeybindingsOptions {
  enabled: boolean;
  onMove: (move: string) => void;
}

export function useKeybindings({ enabled, onMove }: UseKeybindingsOptions) {
  const [bindings, setBindings] = useState<Record<string, string>>(DEFAULT_KEYBINDINGS);
  const [isLoaded, setIsLoaded] = useState(false);
  const accessToken = useAuthStore((s) => s.accessToken);

  // Runtime lookup is key -> move (same shape as the stored profile bindings).
  const keyToMove = useRef<Record<string, string>>({});
  // Store callback in ref to avoid re-attaching listener when callback changes
  const onMoveRef = useRef(onMove);

  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    keyToMove.current = { ...bindings };
  }, [bindings]);

  // Load the user's ACTIVE keybinding profile (key -> move). Falls back to the
  // defaults when unauthenticated, on error, or for an empty profile. Previously
  // this always used DEFAULT_KEYBINDINGS, so custom keybindings never applied.
  useEffect(() => {
    let cancelled = false;
    if (!accessToken) {
      setBindings(DEFAULT_KEYBINDINGS);
      setIsLoaded(true);
      return;
    }
    keybindingsApi
      .getActive(accessToken)
      .then((profile) => {
        if (cancelled) return;
        const b = (profile as { bindings?: Record<string, string> } | null)?.bindings;
        setBindings(b && Object.keys(b).length > 0 ? b : DEFAULT_KEYBINDINGS);
        setIsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBindings(DEFAULT_KEYBINDINGS);
        setIsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  // Handle keydown - only re-attach when enabled/isLoaded changes, not when onMove changes
  useEffect(() => {
    if (!enabled || !isLoaded) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore browser/OS shortcuts (Cmd+R, Ctrl+C, Alt+…): don't fire a cube
      // move and don't preventDefault the shortcut.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Ignore if typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const key = e.key;
      // Try exact key first (for uppercase wide moves), then lowercase
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
