'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { TwistyCube } from '@/components/TwistyCube';
import { LeagueBadge } from '@/components/LeagueBadge';
import { leaderboardApi } from '@/lib/api';
import { LEAGUE_TIERS } from '@plus2/shared';

// Endless twisting for the hero cube: a scramble-ish pool that cycles so the
// cube keeps evolving instead of ping-ponging.
const HERO_MOVE_POOL = [
  'R', 'U', "F'", 'D', 'L', "B'", 'U', "R'", 'F', "D'", 'B', 'L',
  "U'", 'R', 'D', "F'", "L'", 'B', 'U', 'R', "D'", 'F', "B'", "L'",
];

function HeroCube() {
  const [moves, setMoves] = useState<string[]>([]);
  const idxRef = useRef(0);

  useEffect(() => {
    const iv = setInterval(() => {
      const move = HERO_MOVE_POOL[idxRef.current % HERO_MOVE_POOL.length];
      idxRef.current += 1;
      setMoves((prev) => [...prev, move]);
    }, 900);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="card relative overflow-hidden">
      {/* Mimic the real match header so the hero shows the actual product */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm">your opponent</span>
          <LeagueBadge league="diamond" size="sm" />
          <span className="text-[10px] font-bold bg-red-600 text-white rounded px-1.5 py-0.5 animate-pulse">
            LIVE
          </span>
        </div>
        <span className="font-mono text-sm text-gray-400">12.48</span>
      </div>
      <TwistyCube puzzleSize="3x3" moves={moves} animationSpeed={1.5} className="h-64 md:h-80" />
      <p className="text-center text-xs text-gray-500 mt-3">
        You see every turn of your opponent&apos;s cube, live.
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
    title: 'Live 1v1 races',
    body: "Best-of-5, same scramble, split screen. Your opponent's cube animates move by move while you solve — first to finish takes the round.",
  },
  {
    icon: 'ghost',
    title: 'Ghost racing',
    body: "Nobody queueing? Race a recording of a real player near your rating — their solve replays in real time. You'll never see the same scrambles twice.",
  },
  {
    icon: 'trophy',
    title: 'Ranked leagues',
    body: 'ELO-style MMR from Bronze to Grandmaster. Every match and ghost race counts; the leaderboard only lists players who actually compete.',
  },
  {
    icon: 'link',
    title: 'Challenge friends',
    body: 'Create a challenge, send the link, race the moment they click it. Rematch from the results screen and settle it properly.',
  },
  {
    icon: 'chat',
    title: 'Chat',
    body: 'A global room for WCA-verified cubers, plus in-match chat with your opponent. Say gl hf, mean it.',
  },
  {
    icon: 'chart',
    title: 'Replays & progress',
    body: 'Every solve is recorded move-for-move with true timing. Rewatch any match, and track your singles, ao5 and ao12 on your profile.',
  },
];

const STEPS: Array<{ n: string; title: string; body: string }> = [
  {
    n: '1',
    title: 'Learn the keys',
    body: 'Solve on a keyboard-driven 3D cube — every face turn and rotation is a keystroke, fully rebindable.',
  },
  {
    n: '2',
    title: 'Find a race',
    body: 'One button queues you against a live human near your rating — or an unseen ghost when nobody’s around.',
  },
  {
    n: '3',
    title: 'Climb',
    body: 'Win rounds, take matches, earn MMR. Your league badge follows you everywhere on the site.',
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
            Race real opponents on a simulated Rubik&apos;s cube — live, ranked, and
            move-for-move. Like chess online, but your rating is measured in seconds.
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
            Free · keyboard-driven · WCA-style scrambles
            {playerCount !== null && playerCount > 0 && (
              <> · {playerCount.toLocaleString()} ranked cuber{playerCount === 1 ? '' : 's'}</>
            )}
          </p>
        </div>

        <HeroCube />
      </section>

      {/* How it works */}
      <section className="max-w-6xl mx-auto px-6 pb-16">
        <div className="grid md:grid-cols-3 gap-6">
          {STEPS.map((s) => (
            <div key={s.n} className="flex gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-600/20 border border-blue-500 text-blue-400 flex items-center justify-center font-bold">
                {s.n}
              </div>
              <div>
                <h3 className="font-semibold mb-1">{s.title}</h3>
                <p className="text-gray-400 text-sm">{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 pb-16">
        <h2 className="text-3xl font-bold mb-8 text-center">Everything is a race</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {FEATURES.map((f) => (
            <div key={f.title} className="card">
              <div className="text-blue-400 mb-3">{ICONS[f.icon]}</div>
              <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* League ladder */}
      <section className="max-w-6xl mx-auto px-6 pb-16 text-center">
        <h2 className="text-3xl font-bold mb-3">Bronze to Grandmaster</h2>
        <p className="text-gray-400 mb-6">
          Seven leagues. One ladder. Your MMR decides where you stand.
        </p>
        <div className="flex flex-wrap justify-center items-center gap-2">
          {LEAGUE_TIERS.map((tier, i) => (
            <span key={tier} className="flex items-center gap-2">
              <LeagueBadge league={tier} size="md" />
              {i < LEAGUE_TIERS.length - 1 && <span className="text-gray-600">→</span>}
            </span>
          ))}
        </div>
      </section>

      {/* Puzzles + closing CTA */}
      <section className="max-w-6xl mx-auto px-6 pb-20 text-center">
        <div className="flex justify-center gap-3 mb-10">
          {(['2x2', '3x3', '4x4', '5x5'] as const).map((size) => {
            const isAvailable = size === '3x3';
            return (
              <div
                key={size}
                className={`w-14 h-14 flex flex-col items-center justify-center rounded-lg border font-bold text-sm ${
                  isAvailable
                    ? 'bg-blue-600/20 border-blue-500 text-white'
                    : 'bg-gray-800/50 border-gray-700 text-gray-500'
                }`}
              >
                <span>{size}</span>
                {!isAvailable && <span className="text-[9px] text-gray-600">Soon</span>}
              </div>
            );
          })}
        </div>
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
