'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authApi } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import type { LeagueTier } from '@plus2/shared';

interface AuthFormProps {
  mode: 'login' | 'register';
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const { setAuth, setLoading, setError } = useAuthStore();

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');

    if (mode === 'register' && password !== confirmPassword) {
      setLocalError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters');
      return;
    }

    setIsSubmitting(true);

    try {
      const result = mode === 'login'
        ? await authApi.login(email, password)
        : await authApi.register(email, username, password);

      setAuth(
        {
          ...result.user,
          league: result.user.league as LeagueTier,
        },
        result.accessToken,
        result.refreshToken
      );

      router.push('/dashboard');
    } catch (err: any) {
      setLocalError(err.message || 'Something went wrong');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-md">
        <h1 className="text-3xl font-bold text-center mb-8">
          {mode === 'login' ? 'Welcome Back' : 'Create Account'}
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1">
              Email
            </label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@example.com"
              required
            />
          </div>

          {mode === 'register' && (
            <div>
              <label htmlFor="username" className="block text-sm font-medium mb-1">
                Username
              </label>
              <input
                type="text"
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input"
                placeholder="cubemaster"
                pattern="[a-zA-Z0-9_]{3,32}"
                title="3-32 characters, letters, numbers, and underscores only"
                required
              />
            </div>
          )}

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1">
              Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
              minLength={8}
              required
            />
          </div>

          {mode === 'register' && (
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium mb-1">
                Confirm Password
              </label>
              <input
                type="password"
                id="confirmPassword"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input"
                placeholder="••••••••"
                required
              />
            </div>
          )}

          {localError && (
            <div className="text-red-500 text-sm text-center">
              {localError}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-primary w-full py-3 text-lg"
          >
            {isSubmitting
              ? 'Loading...'
              : mode === 'login'
                ? 'Login'
                : 'Create Account'}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-400">
          {mode === 'login' ? (
            <>
              Don&apos;t have an account?{' '}
              <Link href="/register" className="text-blue-500 hover:underline">
                Sign up
              </Link>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <Link href="/login" className="text-blue-500 hover:underline">
                Login
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
