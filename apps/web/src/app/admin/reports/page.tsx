'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { usersApi, reportsApi, type AdminReport } from '@/lib/api';

const STATUS_LABEL: Record<AdminReport['status'], { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-600' },
  confirmed_cheating: { label: 'Cheating', cls: 'bg-red-500/20 text-red-400 border-red-600' },
  clean: { label: 'Clean', cls: 'bg-green-500/20 text-green-400 border-green-600' },
  dismissed: { label: 'Dismissed', cls: 'bg-gray-500/20 text-gray-400 border-gray-600' },
};

export default function AdminReportsPage() {
  const router = useRouter();
  const { user, accessToken, _hasHydrated } = useAuthStore();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (_hasHydrated && (!user || !accessToken)) router.push('/login');
  }, [user, accessToken, router, _hasHydrated]);

  // Admin gate + load
  useEffect(() => {
    if (!accessToken) return;
    usersApi.getMe(accessToken).then((me) => {
      if (!me.isAdmin) {
        setAuthorized(false);
        router.push('/dashboard');
        return;
      }
      setAuthorized(true);
    }).catch(() => setAuthorized(false));
  }, [accessToken, router]);

  const reload = async () => {
    if (!accessToken) return;
    const res = await reportsApi.adminList(accessToken).catch(() => ({ reports: [] }));
    setReports(res.reports);
  };

  useEffect(() => {
    if (authorized) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  const review = async (id: string, status: string) => {
    if (!accessToken) return;
    setBusy(id);
    try {
      await reportsApi.review(accessToken, id, status);
      setReports((prev) => prev.map((r) => (r.id === id ? { ...r, status: status as AdminReport['status'] } : r)));
    } finally {
      setBusy(null);
    }
  };

  const visible = tab === 'pending' ? reports.filter((r) => r.status === 'pending') : reports;

  // Group by reported player, most-reported first — "review by player".
  const grouped = useMemo(() => {
    const map = new Map<string, { username: string; mmr: number; items: AdminReport[] }>();
    for (const r of visible) {
      const g = map.get(r.reportedUserId) || { username: r.reportedUsername, mmr: r.reportedMmr, items: [] };
      g.items.push(r);
      map.set(r.reportedUserId, g);
    }
    return [...map.entries()].sort((a, b) => b[1].items.length - a[1].items.length);
  }, [visible]);

  if (!user || authorized === null) {
    return <div className="min-h-screen flex items-center justify-center text-gray-400">Checking access…</div>;
  }
  if (!authorized) return null;

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-center mb-8">
          <Link href="/dashboard" className="text-gray-400 hover:text-white">&larr; Dashboard</Link>
          <h1 className="text-2xl font-bold">Cheating Reports</h1>
          <div className="w-28" />
        </header>

        <div className="flex gap-2 mb-6">
          {(['pending', 'all'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-full text-sm capitalize border ${
                tab === t ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {t}
              {t === 'pending' && (
                <span className="ml-1.5">{reports.filter((r) => r.status === 'pending').length}</span>
              )}
            </button>
          ))}
        </div>

        {grouped.length === 0 && (
          <div className="card text-center text-gray-400">
            {tab === 'pending' ? 'No pending reports — all clear.' : 'No reports yet.'}
          </div>
        )}

        <div className="space-y-6">
          {grouped.map(([userId, g]) => (
            <div key={userId} className="card">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <Link href={`/profile/${g.username}`} className="text-lg font-bold hover:underline">
                    {g.username}
                  </Link>
                  <span className="text-gray-400 text-sm">{g.mmr} MMR</span>
                  <span className="text-xs bg-red-500/20 text-red-400 border border-red-600 rounded-full px-2 py-0.5">
                    {g.items.length} report{g.items.length === 1 ? '' : 's'}
                  </span>
                </div>
                <Link href={`/profile/${g.username}`} className="text-sm text-blue-400 hover:underline">
                  View profile & solves
                </Link>
              </div>

              <div className="space-y-3">
                {g.items.map((r) => (
                  <div key={r.id} className="bg-gray-800/60 rounded-lg p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm mb-1.5">
                      <span className={`text-xs border rounded-full px-2 py-0.5 ${STATUS_LABEL[r.status].cls}`}>
                        {STATUS_LABEL[r.status].label}
                      </span>
                      <span className="text-gray-400">
                        reported by <span className="text-gray-200">{r.reporterUsername}</span>
                      </span>
                      <span className="text-gray-600">·</span>
                      <span className="text-gray-500">{new Date(r.createdAt).toLocaleString()}</span>
                      <span className="text-gray-600">·</span>
                      {r.contextType === 'match' && r.matchId ? (
                        <Link href={`/match/${r.matchId}/replay`} className="text-blue-400 hover:underline">
                          Watch match replay
                        </Link>
                      ) : (
                        <span className="text-gray-400">Ghost session {r.ghostSessionId?.slice(0, 8)}…</span>
                      )}
                    </div>
                    {r.reason && <p className="text-sm text-gray-300 mb-2">&ldquo;{r.reason}&rdquo;</p>}
                    {r.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          disabled={busy === r.id}
                          onClick={() => review(r.id, 'confirmed_cheating')}
                          className="btn bg-red-600 hover:bg-red-700 text-white px-3 py-1 text-xs disabled:opacity-50"
                        >
                          Confirm cheating
                        </button>
                        <button
                          disabled={busy === r.id}
                          onClick={() => review(r.id, 'clean')}
                          className="btn bg-green-700 hover:bg-green-600 text-white px-3 py-1 text-xs disabled:opacity-50"
                        >
                          Clean
                        </button>
                        <button
                          disabled={busy === r.id}
                          onClick={() => review(r.id, 'dismissed')}
                          className="btn btn-secondary px-3 py-1 text-xs disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
