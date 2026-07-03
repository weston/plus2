'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// WCA-standard scheme (white top, green front).
export const DEFAULT_CUBE_COLORS: Record<string, string> = {
  U: '#FFFFFF',
  D: '#FFFF00',
  F: '#00FF00',
  B: '#0000FF',
  R: '#FF0000',
  L: '#FFA500',
};

interface CubePrefsState {
  // My face colors, applied to MY cube everywhere (match, solo, race,
  // practice, settings preview). Persisted to localStorage so the theme
  // survives reloads; the server copy (user preferences) is what travels to
  // opponents' screens.
  colors: Record<string, string>;
  // Imgur URL of my cube logo (white-face center sticker), or null.
  logo: string | null;
  // Cube turn animation speed (0-10); applies on every page, not just zen.
  speed: number;
  // True once the user edits colors in THIS session — server hydration must
  // then keep its hands off (a slow GET or a stale server copy would revert
  // a fresh local pick).
  modified: boolean;
  setColors: (colors: Record<string, string>) => void;
  setLogo: (logo: string | null) => void;
  setSpeed: (speed: number) => void;
  markModified: () => void;
}

export const useCubePrefs = create<CubePrefsState>()(
  persist(
    (set) => ({
      colors: DEFAULT_CUBE_COLORS,
      logo: null,
      speed: 3,
      modified: false,
      setColors: (colors) => set({ colors: { ...DEFAULT_CUBE_COLORS, ...colors } }),
      setLogo: (logo) => set({ logo }),
      setSpeed: (speed) => set({ speed }),
      markModified: () => set({ modified: true }),
    }),
    {
      name: 'plus2-cube-prefs',
      partialize: (s) => ({ colors: s.colors, logo: s.logo, speed: s.speed }),
    },
  ),
);
