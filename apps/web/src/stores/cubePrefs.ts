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
  setColors: (colors: Record<string, string>) => void;
}

export const useCubePrefs = create<CubePrefsState>()(
  persist(
    (set) => ({
      colors: DEFAULT_CUBE_COLORS,
      setColors: (colors) => set({ colors: { ...DEFAULT_CUBE_COLORS, ...colors } }),
    }),
    { name: 'plus2-cube-prefs' },
  ),
);
