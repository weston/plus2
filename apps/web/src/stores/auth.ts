'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User, LeagueTier } from '@plus2/shared';
import { useGameStore } from './game';
import { useChallengeStore } from './challenge';
import { useChatStore } from './chatroom';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isLoading: boolean;
  error: string | null;
  _hasHydrated: boolean;

  setAuth: (user: User, accessToken: string, refreshToken: string) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  updateUser: (updates: Partial<User>) => void;
  setHasHydrated: (state: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isLoading: false,
      error: null,
      _hasHydrated: false,

      setAuth: (user, accessToken, refreshToken) =>
        set({ user, accessToken, refreshToken, error: null }),

      logout: () => {
        // Best-effort server-side revocation: bumps the user's tokenVersion so
        // any outstanding refresh token stops working. Fire-and-forget with a
        // raw fetch (importing the api client here would create a cycle).
        const token = useAuthStore.getState().accessToken;
        if (token) {
          const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
          fetch(`${base}/auth/logout`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          }).catch(() => {});
        }
        set({ user: null, accessToken: null, refreshToken: null });
        // Clear in-memory app state so one account's match/queue/challenge/chat
        // can't leak into the next session on a shared machine.
        useGameStore.getState().reset();
        useChallengeStore.setState({
          challenge: null,
          error: null,
          incoming: null,
          declinedBy: null,
        });
        useChatStore.setState({
          joined: false,
          canSend: false,
          messages: [],
          matchMessages: [],
        });
      },

      setLoading: (isLoading) => set({ isLoading }),

      setError: (error) => set({ error }),

      updateUser: (updates) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...updates } : null,
        })),

      setHasHydrated: (state) => set({ _hasHydrated: state }),
    }),
    {
      name: 'plus2-auth',
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
