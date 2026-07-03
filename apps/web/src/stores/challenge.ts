'use client';

import { create } from 'zustand';
import type { PuzzleSize, LeagueTier } from '@plus2/shared';

export interface ChallengeInfo {
  code: string;
  puzzleSize: PuzzleSize;
  // Set when this is a direct challenge to a specific player.
  targetUsername?: string | null;
}

export interface IncomingChallenge {
  code: string;
  puzzleSize: PuzzleSize;
  from: { id: string; username: string; mmr: number; league: LeagueTier; country?: string | null };
}

interface ChallengeState {
  challenge: ChallengeInfo | null;
  error: string | null;
  // A direct challenge someone sent ME (renders as a global banner).
  incoming: IncomingChallenge | null;
  // Who declined MY direct challenge (feedback on the challenge page).
  declinedBy: string | null;
  setChallenge: (challenge: ChallengeInfo | null) => void;
  setError: (error: string | null) => void;
  setIncoming: (incoming: IncomingChallenge | null) => void;
  setDeclinedBy: (username: string | null) => void;
}

// Pending-challenge UI state. Lives in a store (not component state) because
// the shared game socket's handlers update it from outside any component.
export const useChallengeStore = create<ChallengeState>((set) => ({
  challenge: null,
  error: null,
  incoming: null,
  declinedBy: null,
  setChallenge: (challenge) => set({ challenge }),
  setError: (error) => set({ error }),
  setIncoming: (incoming) => set({ incoming }),
  setDeclinedBy: (declinedBy) => set({ declinedBy }),
}));
