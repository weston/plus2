'use client';

import { create } from 'zustand';
import type { PuzzleSize } from '@plus2/shared';

export interface ChallengeInfo {
  code: string;
  puzzleSize: PuzzleSize;
}

interface ChallengeState {
  challenge: ChallengeInfo | null;
  error: string | null;
  setChallenge: (challenge: ChallengeInfo | null) => void;
  setError: (error: string | null) => void;
}

// Pending-challenge UI state. Lives in a store (not component state) because
// the shared game socket's handlers update it from outside any component.
export const useChallengeStore = create<ChallengeState>((set) => ({
  challenge: null,
  error: null,
  setChallenge: (challenge) => set({ challenge }),
  setError: (error) => set({ error }),
}));
