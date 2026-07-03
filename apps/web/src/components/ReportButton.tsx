'use client';

import { useState } from 'react';
import { useAuthStore } from '@/stores/auth';
import { reportsApi } from '@/lib/api';

interface ReportButtonProps {
  reportedUserId: string;
  reportedUsername: string;
  contextType: 'match' | 'ghost';
  matchId?: string | null;
  ghostSessionId?: string | null;
  className?: string;
}

/**
 * Small "Report" affordance for post-game screens: expands into a reason box,
 * files a cheating report for admins to audit.
 */
export function ReportButton({
  reportedUserId,
  reportedUsername,
  contextType,
  matchId,
  ghostSessionId,
  className = '',
}: ReportButtonProps) {
  const { accessToken } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  if (!accessToken) return null;

  if (state === 'done') {
    return (
      <p className={`text-sm text-gray-400 ${className}`}>
        Report submitted — an admin will review {reportedUsername}&apos;s solves.
      </p>
    );
  }

  const submit = async () => {
    setState('sending');
    setError('');
    try {
      await reportsApi.create(accessToken, {
        reportedUserId,
        contextType,
        matchId: matchId ?? undefined,
        ghostSessionId: ghostSessionId ?? undefined,
        reason: reason.trim() || undefined,
      });
      setState('done');
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? e.message : 'Failed to submit report');
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`text-sm text-gray-500 hover:text-red-400 underline ${className}`}
      >
        Report suspected cheating
      </button>
    );
  }

  return (
    <div className={`bg-gray-800/60 border border-gray-700 rounded-lg p-3 text-left ${className}`}>
      <p className="text-sm text-gray-300 mb-2">
        Report <span className="font-semibold">{reportedUsername}</span> for cheating?
        An admin will review the recorded solve{contextType === 'match' ? 's from this match' : 's'}.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder="What looked wrong? (optional)"
        className="input w-full text-sm mb-2"
      />
      {error && <p className="text-red-400 text-sm mb-2">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={state === 'sending'}
          className="btn bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {state === 'sending' ? 'Submitting…' : 'Submit report'}
        </button>
        <button onClick={() => setOpen(false)} className="btn btn-secondary px-3 py-1.5 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
