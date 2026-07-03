'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { TwistyCube } from '@/components/TwistyCube';
import { LeagueBadge } from '@/components/LeagueBadge';
import { leaderboardApi } from '@/lib/api';
import { LEAGUE_TIERS } from '@plus2/shared';

// Fallback twisting when no recorded solve is available: a scramble-ish pool
// that cycles so the cube keeps evolving instead of ping-ponging.
const HERO_MOVE_POOL = [
  'R', 'U', "F'", 'D', 'L', "B'", 'U', "R'", 'F', "D'", 'B', 'L',
  "U'", 'R', 'D', "F'", "L'", 'B', 'U', 'R', "D'", 'F', "B'", "L'",
];

interface ShowcaseSolve {
  scramble: string;
  timeMs: number;
  username: string;
  moves: Array<{ move: string; tMs: number }>;
}

// The hero cube replays REAL recorded solves from the community, with their
// true move timing — then loads the next one.
function HeroCube() {
  const [replay, setReplay] = useState<ShowcaseSolve | null>(null);
  const [fallback, setFallback] = useState(false);
  const [moves, setMoves] = useState<string[]>([]);
  const idxRef = useRef(0);
  const genRef = useRef(0);

  const loadNext = () => {
    leaderboardApi
      .getShowcase()
      .then((solve) => {
        if (solve && solve.moves.length >= 4) {
          setReplay(solve);
        } else {
          setFallback(true);
        }
      })
      .catch(() => setFallback(true));
  };

  useEffect(() => {
    loadNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Schedule the recorded moves at their true timestamps; pause, then fetch
  // the next solve.
  useEffect(() => {
    if (!replay) return;
    genRef.current += 1;
    const gen = genRef.current;
    setMoves([]);
    const timers = replay.moves.map((m) =>
      setTimeout(() => {
        if (genRef.current === gen) setMoves((prev) => [...prev, m.move]);
      }, m.tMs + 800),
    );
    const total = replay.moves[replay.moves.length - 1]?.tMs ?? 0;
    const nextTimer = setTimeout(loadNext, total + 4000);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(nextTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay]);

  // Fallback: endless pool twisting (e.g. brand-new database).
  useEffect(() => {
    if (!fallback) return;
    const iv = setInterval(() => {
      const move = HERO_MOVE_POOL[idxRef.current % HERO_MOVE_POOL.length];
      idxRef.current += 1;
      setMoves((prev) => [...prev, move]);
    }, 900);
    return () => clearInterval(iv);
  }, [fallback]);

  return (
    <div className="card relative overflow-hidden">
      {/* Mimic the real match header so the hero shows the actual product */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm">{replay ? replay.username : 'your opponent'}</span>
          <LeagueBadge league="diamond" size="sm" />
          <span className="text-[10px] font-bold bg-purple-600 text-white rounded px-1.5 py-0.5">
            REPLAY
          </span>
        </div>
        <span className="font-mono text-sm text-gray-400">
          {replay ? (replay.timeMs / 1000).toFixed(2) : '12.48'}
        </span>
      </div>
      <TwistyCube
        puzzleSize="3x3"
        scramble={replay?.scramble || ''}
        moves={moves}
        animationSpeed={4}
        className="h-64 md:h-80"
      />
      <p className="text-center text-xs text-gray-500 mt-3">
        {replay ? `A real solve by ${replay.username}` : 'Live opponent view'}
      </p>
    </div>
  );
}

// Inline SVG icons (emoji render as tofu on systems without emoji fonts).
const ICONS: Record<string, JSX.Element> = {
  bolt: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  ghost: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
      <path d="M5 11a7 7 0 0 1 14 0v9l-2.5-2-2.5 2-2-2-2 2-2.5-2L5 20Z" />
      <circle cx="9.5" cy="11" r="0.5" fill="currentColor" />
      <circle cx="14.5" cy="11" r="0.5" fill="currentColor" />
    </svg>
  ),
  trophy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
      <path d="M8 21h8M12 17v4M7 4h10v6a5 5 0 0 1-10 0Z" />
      <path d="M7 6H4a2 2 0 0 0 2 4h1M17 6h3a2 2 0 0 1-2 4h-1" />
    </svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
      <path d="M3 3v18h18" />
      <path d="m7 14 4-4 3 3 5-6" />
    </svg>
  ),
};

const FEATURES: Array<{ icon: string; title: string; body: string }> = [
  {
    icon: 'bolt',
    title: 'Live races',
    body: "Go head to head and watch your opponent's cube turn in real time.",
  },
  {
    icon: 'ghost',
    title: 'Ghost racing',
    body: 'Nobody online? Race a recording of a real player at your level.',
  },
  {
    icon: 'trophy',
    title: 'Ranked',
    body: 'Win races, climb from Bronze to Grandmaster.',
  },
];

export default function HomePage() {
  const { user } = useAuthStore();
  const [playerCount, setPlayerCount] = useState<number | null>(null);

  useEffect(() => {
    leaderboardApi
      .getGlobal(1, 1)
      .then((res) => setPlayerCount(res.total))
      .catch(() => setPlayerCount(null));
  }, []);

  const primaryCta = user
    ? { href: '/dashboard', label: 'Enter Arena' }
    : { href: '/login', label: 'Start Racing' };

  return (
    <main className="min-h-screen">
      {/* Nav */}
      <nav className="max-w-6xl mx-auto flex items-center justify-between px-6 py-5">
        <Link href="/" className="text-2xl font-bold">
          <span className="text-blue-500">Plus</span>
          <span className="text-yellow-500">2</span>
        </Link>
        <div className="flex items-center gap-5">
          <Link href="/leaderboard" className="text-gray-400 hover:text-white text-sm">
            Leaderboard
          </Link>
          <Link href="/practice" className="text-gray-400 hover:text-white text-sm">
            Practice
          </Link>
          <Link href={primaryCta.href} className="btn btn-primary px-4 py-2 text-sm">
            {user ? 'Enter Arena' : 'Login'}
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-10 pb-16 grid md:grid-cols-2 gap-10 items-center">
        <div>
          <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-5">
            Speedcubing,
            <br />
            <span className="text-blue-500">head</span> to <span className="text-yellow-500">head</span>.
          </h1>
          <p className="text-lg text-gray-400 mb-8 max-w-md">
            Race live opponents. Climb the ranks.
          </p>
          <div className="flex flex-wrap gap-3 mb-6">
            <Link href={primaryCta.href} className="btn btn-primary text-lg px-7 py-3">
              {primaryCta.label}
            </Link>
            <Link href="/practice" className="btn btn-secondary text-lg px-7 py-3">
              Try the cube first
            </Link>
          </div>
          <p className="text-sm text-gray-500">
            Free · keyboard-driven
            {playerCount !== null && playerCount > 0 && (
              <> · {playerCount.toLocaleString()} ranked cuber{playerCount === 1 ? '' : 's'}</>
            )}
          </p>
        </div>

        <HeroCube />
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 pb-16">
        <div className="grid md:grid-cols-3 gap-6">
          {FEATURES.map((f) => (
            <div key={f.title} className="card">
              <div className="text-blue-400 mb-3">{ICONS[f.icon]}</div>
              <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
        <p className="text-center text-sm text-gray-500 mt-6">
          Plus friend challenges, full replays, chat, and progress charts.
        </p>
      </section>

      {/* League ladder */}
      <section className="max-w-6xl mx-auto px-6 pb-16 text-center">
        <div className="flex flex-wrap justify-center items-center gap-2">
          {LEAGUE_TIERS.map((tier, i) => (
            <span key={tier} className="flex items-center gap-2">
              <LeagueBadge league={tier} size="md" />
              {i < LEAGUE_TIERS.length - 1 && <span className="text-gray-600">→</span>}
            </span>
          ))}
        </div>
      </section>

      {/* Closing CTA */}
      <section className="max-w-6xl mx-auto px-6 pb-20 text-center">
        <h2 className="text-2xl font-bold mb-4">The clock is running.</h2>
        <Link href={primaryCta.href} className="btn btn-primary text-lg px-8 py-3">
          {primaryCta.label}
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-gray-500">
          <span>
            <span className="text-blue-500 font-bold">Plus</span>
            <span className="text-yellow-500 font-bold">2</span> — competitive cube racing
          </span>
          <div className="flex gap-5">
            <Link href="/leaderboard" className="hover:text-white">Leaderboard</Link>
            <Link href="/practice" className="hover:text-white">Practice</Link>
            <Link href="/login" className="hover:text-white">Login</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
