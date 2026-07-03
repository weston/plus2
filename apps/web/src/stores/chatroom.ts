'use client';

import { create } from 'zustand';

export interface ChatMsg {
  id?: string;
  userId: string;
  username: string;
  country?: string | null;
  text: string;
  ts: number;
}

interface ChatState {
  // Global (front page) chat
  joined: boolean;
  canSend: boolean; // WCA-verified accounts only
  messages: ChatMsg[];
  // In-match chat (reset per match)
  matchMessages: ChatMsg[];

  setJoined: (canSend: boolean, messages: ChatMsg[]) => void;
  addMessage: (msg: ChatMsg) => void;
  addMatchMessage: (msg: ChatMsg) => void;
  resetMatchChat: () => void;
  leave: () => void;
}

const MAX_MESSAGES = 100;

// Populated by the shared game socket's handlers (see useSocket).
export const useChatStore = create<ChatState>((set) => ({
  joined: false,
  canSend: false,
  messages: [],
  matchMessages: [],

  setJoined: (canSend, messages) => set({ joined: true, canSend, messages }),

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg].slice(-MAX_MESSAGES) })),

  addMatchMessage: (msg) =>
    set((s) => ({ matchMessages: [...s.matchMessages, msg].slice(-MAX_MESSAGES) })),

  resetMatchChat: () => set({ matchMessages: [] }),

  leave: () => set({ joined: false }),
}));
