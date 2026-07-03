'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { usersApi, UserProfile } from '@/lib/api';
import { LeagueBadge } from '@/components/LeagueBadge';
import { CountryFlag } from '@/components/CountryFlag';
import { useAuthStore } from '@/stores/auth';
import { computeBadges, computeChampionshipBadges, computeRecordBadge, type WcaAchievements } from '@plus2/shared';
import type { LeagueTier } from '@plus2/shared';

const BADGE_RING: Record<string, string> = {
  bronze: 'ring-amber-700/50',
  silver: 'ring-gray-400/50',
  gold: 'ring-yellow-400/60',
  special: 'ring-purple-400/60',
};

interface MmrHistoryPoint {
  date: string;
  mmr: number;
  matchId: string;
}

interface MatchHistoryItem {
  id: string;
  type: 'pvp';
  puzzleSize: string;
  player1: { id: string; username: string };
  player2: { id: string; username: string };
  player1Score: number;
  player2Score: number;
  player1MmrBefore: number;
  player1MmrAfter: number;
  player2MmrBefore: number;
  player2MmrAfter: number;
  winnerId: string;
  status: string;
  createdAt: string;
  endedAt: string;
}

interface GhostRaceHistoryItem {
  id: string;
  type: 'ghost';
  role: 'racer' | 'ghost';
  puzzleSize: string;
  opponent: { id: string; username: string };
  myScore: number;
  opponentScore: number;
  won: boolean;
  mmrBefore: number | null;
  mmrAfter: number | null;
  isOldGhost: boolean;
  createdAt: string;
}

type HistoryItem = MatchHistoryItem | GhostRaceHistoryItem;

function formatTime(ms: number | null): string {
  if (!ms) return '-';
  const seconds = ms / 1000;
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(2);
    return `${mins}:${secs.padStart(5, '0')}`;
  }
  return seconds.toFixed(2) + 's';
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function MmrChart({ history }: { history: MmrHistoryPoint[] }) {
  if (history.length < 2) {
    return (
      <div className="h-40 flex items-center justify-center text-gray-500">
        Not enough data for graph
      </div>
    );
  }

  const mmrValues = history.map(h => h.mmr);
  const minMmr = Math.min(...mmrValues) - 50;
  const maxMmr = Math.max(...mmrValues) + 50;
  const range = maxMmr - minMmr;

  const width = 100;
  const height = 40;
  const padding = 2;

  const points = history.map((h, i) => {
    const x = padding + (i / (history.length - 1)) * (width - padding * 2);
    const y = height - padding - ((h.mmr - minMmr) / range) * (height - padding * 2);
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="h-40">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full" preserveAspectRatio="none">
        <polyline
          points={points}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>{minMmr.toFixed(0)}</span>
        <span>{maxMmr.toFixed(0)}</span>
      </div>
    </div>
  );
}

interface SolvePoint {
  date: string;
  timeMs: number;
  source: 'match' | 'solo';
}

// WCA-style trimmed rolling average: over the last n solves, drop the best and
// worst, mean the rest. Returns null until n solves exist.
function rollingAverage(times: number[], index: number, n: number): number | null {
  if (index + 1 < n) return null;
  const window = times.slice(index + 1 - n, index + 1);
  const sorted = [...window].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1);
  return trimmed.reduce((s, t) => s + t, 0) / trimmed.length;
}

// Solve-time progress chart: singles as muted dots, rolling ao5/ao12 as lines,
// plotted against date. Colors validated (CVD + contrast) against the card
// surface (#14141c): ao5 #3987e5, ao12 #199e70, singles muted #898781.
function SolveTimesChart({ history }: { history: SolvePoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (history.length < 5) {
    return (
      <div className="h-40 flex items-center justify-center text-gray-500">
        Not enough solves yet
      </div>
    );
  }

  const W = 640;
  const H = 240;
  const PAD = { top: 12, right: 56, bottom: 24, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const times = history.map((p) => p.timeMs);
  const ao5 = times.map((_, i) => rollingAverage(times, i, 5));
  const ao12 = times.map((_, i) => rollingAverage(times, i, 12));

  const ts = history.map((p) => new Date(p.date).getTime());
  // Index-based x with date ticks: solves arrive in session bursts, so a
  // date-scaled axis collapses everything into vertical stripes. Uniform
  // solve spacing (the cubing convention) keeps the trend readable while the
  // tick labels still anchor it in calendar time.
  const xFor = (i: number) => PAD.left + (i / Math.max(1, history.length - 1)) * plotW;

  const allVals = [...times, ...ao5, ...ao12].filter((v): v is number => v !== null);
  const minV = Math.min(...allVals) * 0.92;
  const maxV = Math.max(...allVals) * 1.05;
  const yFor = (v: number) => PAD.top + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;

  // ~4 clean y ticks in seconds
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount }, (_, i) => minV + ((maxV - minV) * (i + 0.5)) / tickCount);
  // 3 x (date) ticks — drop consecutive duplicates so labels never collide
  const shortDateOf = (t: number) =>
    new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const xTickIdx = [0, Math.floor(history.length / 2), history.length - 1].filter(
    (idx, k, arr) => k === 0 || shortDateOf(ts[idx]) !== shortDateOf(ts[arr[k - 1]]),
  );

  const linePath = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v === null ? null : `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');

  const fmtSec = (ms: number) => (ms / 1000).toFixed(1);
  const shortDate = shortDateOf;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < history.length; i++) {
      const d = Math.abs(xFor(i) - mx);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    setHoverIdx(best);
  };

  const hover = hoverIdx !== null
    ? {
        i: hoverIdx,
        x: xFor(hoverIdx),
        rows: [
          ['single', times[hoverIdx], '#898781'],
          ['ao5', ao5[hoverIdx], '#3987e5'],
          ['ao12', ao12[hoverIdx], '#199e70'],
        ].filter(([, v]) => v !== null) as Array<[string, number, string]>,
      }
    : null;
  const tooltipW = 108;
  const tooltipX = hover ? Math.min(Math.max(hover.x + 8, PAD.left), W - PAD.right - tooltipW) : 0;

  return (
    <div>
      {/* Legend: identity via glyph + text token, never text in series color */}
      <div className="flex gap-4 text-xs text-gray-400 mb-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#898781' }} />
          single
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ background: '#3987e5' }} />
          ao5
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ background: '#199e70' }} />
          ao12
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* hairline gridlines + y tick labels (seconds) */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 6}
              y={yFor(v) + 3}
              textAnchor="end"
              fontSize="10"
              fill="#898781"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtSec(v)}s
            </text>
          </g>
        ))}

        {/* x tick labels (dates) */}
        {xTickIdx.map((i, k) => (
          <text
            key={k}
            x={xFor(i)}
            y={H - 8}
            textAnchor={k === 0 ? 'start' : k === xTickIdx.length - 1 ? 'end' : 'middle'}
            fontSize="10"
            fill="#898781"
          >
            {shortDate(ts[i])}
          </text>
        ))}

        {/* singles: muted context dots */}
        {history.map((p, i) => (
          <circle key={i} cx={xFor(i)} cy={yFor(p.timeMs)} r="2.4" fill="#898781" opacity="0.5" />
        ))}

        {/* rolling averages */}
        <polyline
          points={linePath(ao5)}
          fill="none"
          stroke="#3987e5"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <polyline
          points={linePath(ao12)}
          fill="none"
          stroke="#199e70"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* direct end labels (ink, beside the colored mark) */}
        {(() => {
          const lastAo5 = [...ao5].reverse().findIndex((v) => v !== null);
          const lastAo12 = [...ao12].reverse().findIndex((v) => v !== null);
          const i5 = lastAo5 >= 0 ? ao5.length - 1 - lastAo5 : -1;
          const i12 = lastAo12 >= 0 ? ao12.length - 1 - lastAo12 : -1;
          let y5 = i5 >= 0 ? yFor(ao5[i5]!) + 3 : 0;
          let y12 = i12 >= 0 ? yFor(ao12[i12]!) + 3 : 0;
          // Nudge apart when the line ends converge so the labels don't overlap.
          if (i5 >= 0 && i12 >= 0 && Math.abs(y5 - y12) < 12) {
            const gap = 12 - Math.abs(y5 - y12);
            if (y5 <= y12) { y5 -= gap / 2; y12 += gap / 2; }
            else { y12 -= gap / 2; y5 += gap / 2; }
          }
          return (
            <>
              {i5 >= 0 && (
                <text x={W - PAD.right + 6} y={y5} fontSize="10" fill="#c3c2b7">
                  ao5
                </text>
              )}
              {i12 >= 0 && (
                <text x={W - PAD.right + 6} y={y12} fontSize="10" fill="#c3c2b7">
                  ao12
                </text>
              )}
            </>
          );
        })()}

        {/* hover: crosshair + tooltip */}
        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="1"
            />
            <circle cx={hover.x} cy={yFor(times[hover.i])} r="3.5" fill="#898781" stroke="#14141c" strokeWidth="2" />
            <rect
              x={tooltipX}
              y={PAD.top}
              width={tooltipW}
              height={16 + hover.rows.length * 14}
              rx="6"
              fill="#1f1f2b"
              stroke="rgba(255,255,255,0.12)"
            />
            <text x={tooltipX + 8} y={PAD.top + 13} fontSize="9" fill="#898781">
              {shortDate(ts[hover.i])}
            </text>
            {hover.rows.map(([label, v, color], r) => (
              <g key={label}>
                <circle cx={tooltipX + 11} cy={PAD.top + 24 + r * 14} r="3" fill={color} />
                <text
                  x={tooltipX + 19}
                  y={PAD.top + 27 + r * 14}
                  fontSize="10"
                  fill="#c3c2b7"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {label} {fmtSec(v)}s
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

export default function ProfilePage() {
  const params = useParams();
  const username = params.username as string;
  const { user, accessToken } = useAuthStore();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [mmrHistory, setMmrHistory] = useState<MmrHistoryPoint[]>([]);
  const [solveHistory, setSolveHistory] = useState<SolvePoint[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [ghostRecordingCount, setGhostRecordingCount] = useState(0);
  const [availableGhostsCount, setAvailableGhostsCount] = useState(0);
  const [championships, setChampionships] = useState<WcaAchievements | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guard against out-of-order responses overwriting newer state.
    let cancelled = false;

    async function loadProfile() {
      try {
        setLoading(true);
        setError(null);

        const profileData = await usersApi.getProfileByUsername(username);
        if (cancelled) return;
        setProfile(profileData);

        // Pull major-championship podium/win achievements (public WCA API) for badges.
        if (profileData.wcaId) {
          usersApi
            .getChampionshipAchievements(profileData.wcaId)
            .then((c) => {
              if (!cancelled) setChampionships(c);
            })
            .catch(() => {});
        } else {
          setChampionships(null);
        }

        // Load MMR history, solve history, matches, ghost races, and ghost recording count
        const [historyData, solveHistoryData, matchesData, ghostRacesData, ghostData] = await Promise.all([
          usersApi.getMmrHistory(profileData.id),
          usersApi.getSolveHistory(profileData.id).catch(() => []),
          usersApi.getUserMatches(profileData.id),
          usersApi.getUserGhostRaces(profileData.id),
          usersApi.getGhostRecordingCount(profileData.id),
        ]);
        if (cancelled) return;

        setMmrHistory(historyData);
        setSolveHistory(solveHistoryData);
        setGhostRecordingCount(ghostData.count);

        // Combine matches and ghost races, then sort by date
        const pvpMatches: HistoryItem[] = matchesData.matches.map(m => ({ ...m, type: 'pvp' as const }));
        const ghostRaces: HistoryItem[] = ghostRacesData.races.map(r => ({ ...r, type: 'ghost' as const }));
        const combined = [...pvpMatches, ...ghostRaces].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setHistoryItems(combined);

        // If logged in and viewing someone else's profile, check available ghosts
        if (accessToken && user && user.id !== profileData.id) {
          const availableData = await usersApi.getAvailableGhostsCount(accessToken, profileData.id);
          if (cancelled) return;
          setAvailableGhostsCount(availableData.count);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (username) {
      loadProfile();
    }

    return () => {
      cancelled = true;
    };
    // Depend on user.id (not the whole user object) so an MMR/profile update that
    // replaces the user reference doesn't trigger a full refetch.
  }, [username, accessToken, user?.id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading profile...</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error || 'User not found'}</p>
          <Link href="/" className="text-blue-500 hover:underline">
            Go home
          </Link>
        </div>
      </div>
    );
  }

  // Calculate totals (only 3x3 for now)
  const stats3x3 = profile.stats.filter(s => s.puzzleSize === '3x3');
  const totalGames = stats3x3.reduce((sum, s) => sum + s.gamesPlayed, 0);
  const totalWins = stats3x3.reduce((sum, s) => sum + s.gamesWon, 0);
  const winRate = totalGames > 0 ? ((totalWins / totalGames) * 100).toFixed(1) : '0';

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Back link */}
        <Link href="/dashboard" className="text-gray-400 hover:text-white mb-6 inline-block">
          ← Back
        </Link>

        {/* Profile Header */}
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <CountryFlag country={profile.country} size="lg" />
              <div>
                <h1 className="text-3xl font-bold">{profile.username}</h1>
                <div className="flex items-center gap-2 mt-1">
                  <LeagueBadge league={profile.league as LeagueTier} />
                  <span className="text-gray-400">{profile.mmr} MMR</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Direct challenge (they must be online to receive it) */}
              {user && user.id !== profile.id && (
                <Link
                  href={`/challenge?to=${encodeURIComponent(profile.username)}`}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-all"
                >
                  Challenge
                </Link>
              )}
              {/* Race Against Ghosts Button */}
              {user && user.id !== profile.id && availableGhostsCount > 0 && (
                <Link
                  href={`/solo/race?opponent=${profile.id}`}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-lg font-medium transition-all"
                >
                  Race Ghost ({availableGhostsCount})
                </Link>
              )}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold">{totalGames}</p>
              <p className="text-gray-400 text-sm">Games Played</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-500">{totalWins}</p>
              <p className="text-gray-400 text-sm">Wins</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{winRate}%</p>
              <p className="text-gray-400 text-sm">Win Rate</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-orange-500">{ghostRecordingCount}</p>
              <p className="text-gray-400 text-sm">Ghost Recordings</p>
            </div>
          </div>
        </div>

        {/* In-app badges (league progression) */}
        {(() => {
          const badges = computeBadges({ league: profile.league as LeagueTier });
          if (badges.length === 0) return null;
          return (
            <div className="card mb-6">
              <h2 className="text-xl font-bold mb-4">Badges</h2>
              <div className="flex flex-wrap gap-3">
                {badges.map((b) => (
                  <div
                    key={b.id}
                    title={b.description}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 ring-1 ${BADGE_RING[b.tier] || 'ring-gray-600'}`}
                  >
                    <span className="text-xl leading-none">{b.icon}</span>
                    <span className="text-sm font-medium">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* WCA Profile — real-world competition results, kept visually distinct
            from the in-app stats (championship badges, records, podium counts). */}
        {profile.wcaId && (() => {
          const wcaBadges = [
            ...computeChampionshipBadges(championships),
            ...computeRecordBadge(championships?.recordTier),
          ];
          const medals = championships?.medals;
          const hasMedals = !!medals && medals.gold + medals.silver + medals.bronze > 0;
          return (
            <div className="card mb-6 border border-sky-500/30 bg-gradient-to-br from-sky-950/30 to-transparent">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold">WCA Profile</h2>
                  <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 font-semibold">
                    Official
                  </span>
                </div>
                <a
                  href={`https://www.worldcubeassociation.org/persons/${profile.wcaId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-mono text-sky-300 hover:text-sky-200"
                  title="View WCA profile"
                >
                  {profile.wcaId} ↗
                </a>
              </div>

              {wcaBadges.length > 0 && (
                <div className="flex flex-wrap gap-3 mb-5">
                  {wcaBadges.map((b) => (
                    <div
                      key={b.id}
                      title={b.description}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 ring-1 ${BADGE_RING[b.tier] || 'ring-gray-600'}`}
                    >
                      <span className="text-xl leading-none">{b.icon}</span>
                      <span className="text-sm font-medium">{b.label}</span>
                    </div>
                  ))}
                </div>
              )}

              {hasMedals && medals && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Competition Podiums</h3>
                  <div className="flex gap-8">
                    {([
                      ['🥇', medals.gold, '1st place'],
                      ['🥈', medals.silver, '2nd place'],
                      ['🥉', medals.bronze, '3rd place'],
                    ] as const).map(([icon, count, label]) => (
                      <div key={label} className="flex items-center gap-3">
                        <span className="text-3xl leading-none">{icon}</span>
                        <div>
                          <div className="text-2xl font-bold">{count}</div>
                          <div className="text-xs text-gray-400">{label}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {wcaBadges.length === 0 && !hasMedals && (
                <p className="text-gray-400 text-sm">No championship podiums or records yet.</p>
              )}
            </div>
          );
        })()}

        {/* Stats by Puzzle */}
        <div className="card mb-6">
          <h2 className="text-xl font-bold mb-4">Stats by Puzzle</h2>
          <div className="grid gap-4">
            {profile.stats.filter(s => s.puzzleSize === '3x3').length === 0 ? (
              <p className="text-gray-400">No stats yet</p>
            ) : (
              profile.stats
                .filter((stat) => stat.puzzleSize === '3x3')
                .map((stat) => (
                  <div key={stat.id} className="bg-gray-800/50 rounded-lg p-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-lg">{stat.puzzleSize}</span>
                      <div className="flex items-center gap-2">
                        <LeagueBadge league={stat.league as LeagueTier} size="sm" />
                        <span className="text-gray-400">{stat.mmr} MMR</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-sm">
                      <div>
                        <p className="text-gray-400">Games</p>
                        <p>{stat.gamesPlayed}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Wins</p>
                        <p className="text-green-500">{stat.gamesWon}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Best Time</p>
                        <p className="text-yellow-500">{formatTime(stat.bestTimeMs)}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Avg Time</p>
                        <p>{formatTime(stat.avgTimeMs)}</p>
                      </div>
                    </div>
                  </div>
                ))
            )}
            <p className="text-gray-500 text-sm text-center mt-2">
              More puzzle sizes (2x2, 4x4, 5x5) coming soon
            </p>
          </div>
        </div>

        {/* MMR History Chart */}
        <div className="card mb-6">
          <h2 className="text-xl font-bold mb-4">MMR History</h2>
          <MmrChart history={mmrHistory} />
        </div>

        {/* Solve Times Progress */}
        <div className="card mb-6">
          <h2 className="text-xl font-bold mb-4">Solve Times</h2>
          <SolveTimesChart history={solveHistory} />
        </div>

        {/* Match History */}
        <div className="card">
          <h2 className="text-xl font-bold mb-4">Match History</h2>
          {historyItems.length === 0 ? (
            <p className="text-gray-400">No matches yet</p>
          ) : (
            <div className="space-y-2">
              {historyItems.map((item) => {
                if (item.type === 'ghost') {
                  // Ghost race
                  const mmrDelta = item.mmrBefore !== null && item.mmrAfter !== null
                    ? item.mmrAfter - item.mmrBefore
                    : null;
                  return (
                    <div
                      key={item.id}
                      className={`flex items-center justify-between p-3 rounded-lg ${
                        item.won ? 'bg-green-900/20 border border-green-800/30' : 'bg-red-900/20 border border-red-800/30'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`font-bold ${item.won ? 'text-green-500' : 'text-red-500'}`}>
                          {item.won ? 'W' : 'L'}
                        </span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          item.role === 'racer'
                            ? 'bg-orange-600/30 text-orange-400'
                            : 'bg-purple-600/30 text-purple-400'
                        }`}>
                          {item.role === 'racer' ? 'vs Ghost' : 'Your Ghost'}
                        </span>
                        <span className="text-gray-400 text-sm">{item.puzzleSize}</span>
                        <span>vs</span>
                        <Link
                          href={`/profile/${item.opponent.username}`}
                          className="text-blue-400 hover:underline"
                        >
                          {item.opponent.username}
                        </Link>
                        {item.isOldGhost && (
                          <span className="text-xs text-gray-500">(old)</span>
                        )}
                      </div>

                      <div className="flex items-center gap-4">
                        <span className="font-mono">
                          {item.myScore} - {item.opponentScore}
                        </span>
                        {mmrDelta !== null ? (
                          <span className={`font-mono ${mmrDelta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            {mmrDelta >= 0 ? '+' : ''}{mmrDelta}
                          </span>
                        ) : (
                          <span className="font-mono text-gray-500">-</span>
                        )}
                        <span className="text-gray-500 text-sm">
                          {formatDate(item.createdAt)}
                        </span>
                      </div>
                    </div>
                  );
                } else {
                  // PvP match
                  const isPlayer1 = item.player1.id === profile.id;
                  const opponent = isPlayer1 ? item.player2 : item.player1;
                  const myScore = isPlayer1 ? item.player1Score : item.player2Score;
                  const oppScore = isPlayer1 ? item.player2Score : item.player1Score;
                  const won = item.winnerId === profile.id;
                  const mmrBefore = isPlayer1 ? item.player1MmrBefore : item.player2MmrBefore;
                  const mmrAfter = isPlayer1 ? item.player1MmrAfter : item.player2MmrAfter;
                  const mmrDelta = mmrAfter - mmrBefore;

                  return (
                    <div
                      key={item.id}
                      className={`flex items-center justify-between p-3 rounded-lg ${
                        won ? 'bg-green-900/20 border border-green-800/30' : 'bg-red-900/20 border border-red-800/30'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`font-bold ${won ? 'text-green-500' : 'text-red-500'}`}>
                          {won ? 'W' : 'L'}
                        </span>
                        <span className="text-gray-400 text-sm">{item.puzzleSize}</span>
                        <span>vs</span>
                        <Link
                          href={`/profile/${opponent.username}`}
                          className="text-blue-400 hover:underline"
                        >
                          {opponent.username}
                        </Link>
                      </div>

                      <div className="flex items-center gap-4">
                        <span className="font-mono">
                          {myScore} - {oppScore}
                        </span>
                        <span className={`font-mono ${mmrDelta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {mmrDelta >= 0 ? '+' : ''}{mmrDelta}
                        </span>
                        <span className="text-gray-500 text-sm">
                          {formatDate(item.endedAt || item.createdAt)}
                        </span>
                        <Link
                          href={`/match/${item.id}/replay`}
                          className="text-blue-500 hover:text-blue-400 text-sm"
                        >
                          View
                        </Link>
                      </div>
                    </div>
                  );
                }
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
