'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useChallengeStore } from '@/stores/challenge';
import { useGameStore } from '@/stores/game';
import { useAuthStore } from '@/stores/auth';
import { useSocket } from '@/hooks/useSocket';
import { LeagueBadge } from './LeagueBadge';
import { CountryFlag } from './CountryFlag';
import type { LeagueTier } from '@plus2/shared';

/**
 * Global banner for direct challenges: whichever page you're on, a knock
 * from another player shows up bottom-right with Accept / Decline.
 */
export function IncomingChallengeBanner() {
  const router = useRouter();
  const { user } = useAuthStore();
  const incoming = useChallengeStore((s) => s.incoming);
  const phase = useGameStore((s) => s.phase);
  const { joinChallenge, declineChallenge } = useSocket();
  const acceptedRef = useRef(false);

  // After WE accept, follow the match as soon as it starts. (The dashboard
  // and challenge pages have their own redirects; this covers every other
  // page the banner can appear on.)
  useEffect(() => {
    if (acceptedRef.current && phase === 'matched') {
      acceptedRef.current = false;
      router.push('/match');
    }
  }, [phase, router]);

  if (!incoming || !user) return null;

  const accept = () => {
    acceptedRef.current = true;
    joinChallenge(incoming.code);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 card border border-blue-500 shadow-xl max-w-sm animate-[slideIn_.2s_ease-out]">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold bg-blue-600 text-white rounded px-1.5 py-0.5">
          CHALLENGE
        </span>
        <span className="text-xs text-gray-400">{incoming.puzzleSize}</span>
      </div>
      <div className="flex items-center gap-2 mb-3">
        {incoming.from.country && <CountryFlag country={incoming.from.country} size="sm" />}
        <span className="font-bold">{incoming.from.username}</span>
        <LeagueBadge league={incoming.from.league as LeagueTier} size="sm" />
        <span className="text-gray-400 text-sm">{incoming.from.mmr} MMR</span>
      </div>
      <p className="text-sm text-gray-300 mb-3">wants to race you!</p>
      <div className="flex gap-2">
        <button onClick={accept} className="btn btn-primary flex-1 py-2 text-sm">
          Accept
        </button>
        <button
          onClick={() => declineChallenge(incoming.code)}
          className="btn btn-secondary flex-1 py-2 text-sm"
        >
          Decline
        </button>
      </div>
    </div>
  );
}
