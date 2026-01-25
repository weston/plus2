'use client';

import type { LeagueTier } from '@plus2/shared';

interface LeagueBadgeProps {
  league: LeagueTier;
  size?: 'sm' | 'md' | 'lg';
}

const leagueColors: Record<LeagueTier, string> = {
  bronze: 'bg-[#CD7F32] text-black',
  silver: 'bg-[#C0C0C0] text-black',
  gold: 'bg-[#FFD700] text-black',
  platinum: 'bg-[#E5E4E2] text-black',
  diamond: 'bg-[#B9F2FF] text-black',
  master: 'bg-[#FF6B6B] text-white',
  grandmaster: 'bg-[#9B59B6] text-white',
};

const sizes = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
  lg: 'px-4 py-1.5 text-base',
};

export function LeagueBadge({ league, size = 'md' }: LeagueBadgeProps) {
  return (
    <span
      className={`inline-flex items-center font-semibold rounded-full capitalize ${leagueColors[league]} ${sizes[size]}`}
    >
      {league}
    </span>
  );
}
