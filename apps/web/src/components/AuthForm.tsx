'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usersApi } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import type { LeagueTier } from '@plus2/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

interface AuthFormProps {
  mode: 'login' | 'register';
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const { setAuth } = useAuthStore();
  const [error, setError] = useState('');

  // Handle the OAuth callback: the API redirects back with tokens in the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const at = params.get('accessToken');
    const rt = params.get('refreshToken');
    if (at && rt) {
      usersApi
        .getMe(at)
        .then((p) => {
          setAuth(
            {
              id: p.id,
              email: '',
              username: p.username,
              mmr: p.mmr,
              league: p.league as LeagueTier,
              createdAt: p.createdAt,
            },
            at,
            rt,
          );
          router.push('/dashboard');
        })
        .catch(() => setError('Sign-in failed. Please try again.'));
    } else if (params.get('error') === 'google') {
      setError('Google sign-in failed. Please try again.');
    } else if (params.get('error') === 'wca') {
      setError('WCA sign-in failed. Please try again.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-md">
        <h1 className="text-3xl font-bold text-center mb-2">
          {mode === 'login' ? 'Welcome to plus2' : 'Join plus2'}
        </h1>
        <p className="text-center text-gray-400 mb-8">Sign in or create an account</p>

        <a
          href={`${API_BASE}/auth/google`}
          className="btn btn-secondary w-full py-3 flex items-center justify-center gap-2"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" />
            <path fill="#FBBC05" d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3-2.33z" />
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z" />
          </svg>
          Continue with Google
        </a>

        <a
          href={`${API_BASE}/auth/wca`}
          className="btn btn-secondary w-full py-3 mt-3 flex items-center justify-center gap-2"
        >
          <span className="text-base" aria-hidden="true">🧩</span>
          Continue with WCA
        </a>

        {error && <div className="text-red-500 text-sm text-center mt-4">{error}</div>}

        <p className="text-center text-xs text-gray-500 mt-6">
          By continuing you agree to fair play. You can link your other account later in Settings.
        </p>
      </div>
    </div>
  );
}
