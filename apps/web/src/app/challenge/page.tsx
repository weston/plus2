'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import { useChallengeStore } from '@/stores/challenge';
import { useSocket } from '@/hooks/useSocket';
import type { PuzzleSize } from '@plus2/shared';

const PUZZLE_SIZES: PuzzleSize[] = ['2x2', '3x3', '4x4', '5x5'];
const AVAILABLE_SIZES: PuzzleSize[] = ['3x3']; // Only 3x3 available for now

function ChallengeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const joinCode = searchParams.get('code');
  const targetUsername = searchParams.get('to');

  const { user, accessToken, _hasHydrated } = useAuthStore();
  const { phase } = useGameStore();
  const { challenge, challengeError, createChallenge, cancelChallenge, joinChallenge } = useSocket();
  const declinedBy = useChallengeStore((s) => s.declinedBy);

  const [selectedSize, setSelectedSize] = useState<PuzzleSize>('3x3');
  const [joinInput, setJoinInput] = useState(joinCode || '');
  const [copied, setCopied] = useState(false);

  // Redirect if not logged in
  useEffect(() => {
    if (_hasHydrated && (!user || !accessToken)) {
      router.push('/login');
    }
  }, [user, accessToken, router, _hasHydrated]);

  // Auto-join if code is in URL
  useEffect(() => {
    if (joinCode && accessToken && !challenge) {
      joinChallenge(joinCode);
    }
  }, [joinCode, accessToken, challenge, joinChallenge]);

  // Direct challenge (?to=username from a profile): send it immediately.
  const directSentRef = useRef(false);
  useEffect(() => {
    if (targetUsername && accessToken && !challenge && !directSentRef.current) {
      directSentRef.current = true;
      createChallenge(selectedSize, targetUsername);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUsername, accessToken]);

  // Redirect to match when found
  useEffect(() => {
    if (phase === 'matched') {
      router.push('/match');
    }
  }, [phase, router]);

  // The socket now survives navigation, so leaving this page no longer
  // implicitly cancels a pending challenge via a disconnect — do it
  // explicitly. When the match starts, the challenge store is cleared before
  // the /match navigation, so this is a no-op in that path.
  useEffect(() => {
    return () => {
      if (useChallengeStore.getState().challenge) {
        cancelChallenge();
      }
    };
  }, [cancelChallenge]);

  const handleCreateChallenge = () => {
    createChallenge(selectedSize);
  };

  const handleCancelChallenge = () => {
    cancelChallenge();
  };

  const handleJoinChallenge = (e: React.FormEvent) => {
    e.preventDefault();
    if (joinInput.trim()) {
      joinChallenge(joinInput.trim());
    }
  };

  const handleCopyLink = async () => {
    if (challenge) {
      const link = `${window.location.origin}/challenge?code=${challenge.code}`;
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!user) return null;

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <header className="flex justify-between items-center mb-8">
          <Link href="/dashboard" className="text-gray-400 hover:text-white">
            &larr; Back to Dashboard
          </Link>
          <h1 className="text-2xl font-bold">Challenge Match</h1>
          <div className="w-32" />
        </header>

        {challenge ? (
          // Waiting for opponent
          <div className="card text-center">
            <h2 className="text-xl font-semibold mb-6">
              {challenge.targetUsername ? `Challenge sent to ${challenge.targetUsername}` : 'Challenge Created'}
            </h2>

            {!challenge.targetUsername && (
              <>
                <div className="mb-6">
                  <p className="text-gray-400 mb-2">Share this code with a friend:</p>
                  <div className="text-4xl font-mono font-bold tracking-widest text-blue-400 mb-4">
                    {challenge.code}
                  </div>
                  <div className="text-sm text-gray-500">
                    Puzzle: {challenge.puzzleSize}
                  </div>
                </div>

                <div className="mb-6">
                  <p className="text-gray-400 mb-2">Or share this link:</p>
                  <div className="flex gap-2 justify-center">
                    <input
                      type="text"
                      readOnly
                      value={`${typeof window !== 'undefined' ? window.location.origin : ''}/challenge?code=${challenge.code}`}
                      className="input text-center text-sm flex-1 max-w-md"
                    />
                    <button
                      onClick={handleCopyLink}
                      className="btn btn-secondary px-4"
                    >
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              </>
            )}

            <div className="flex items-center justify-center gap-2 text-gray-400 mb-8">
              <span className="animate-spin">&#9696;</span>
              <span>
                {challenge.targetUsername
                  ? `Waiting for ${challenge.targetUsername} to accept... (${challenge.puzzleSize})`
                  : 'Waiting for opponent to join...'}
              </span>
            </div>

            <button
              onClick={handleCancelChallenge}
              className="btn bg-red-600 hover:bg-red-700"
            >
              Cancel Challenge
            </button>
          </div>
        ) : (
          // Create or join challenge
          <div className="space-y-8">
            {/* Create Challenge */}
            <div className="card">
              <h2 className="text-xl font-semibold mb-4">Create a Challenge</h2>
              <p className="text-gray-400 mb-4">
                Generate a code to share with a friend for a private match.
              </p>

              <div className="grid grid-cols-2 gap-3 mb-6">
                {PUZZLE_SIZES.map((size) => {
                  const isAvailable = AVAILABLE_SIZES.includes(size);
                  return (
                    <button
                      key={size}
                      onClick={() => isAvailable && setSelectedSize(size)}
                      disabled={!isAvailable}
                      className={`p-4 rounded-lg border-2 transition-all ${
                        selectedSize === size && isAvailable
                          ? 'border-blue-500 bg-blue-500/20'
                          : isAvailable
                          ? 'border-gray-700 hover:border-gray-600'
                          : 'border-gray-800 opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <div className="text-xl font-bold">{size}</div>
                      <div className="text-sm text-gray-400">
                        {isAvailable ? 'Available' : 'Coming Soon'}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                onClick={handleCreateChallenge}
                className="btn btn-primary w-full py-4 text-lg font-bold"
              >
                Create Challenge
              </button>
            </div>

            {/* Join Challenge */}
            <div className="card">
              <h2 className="text-xl font-semibold mb-4">Join a Challenge</h2>
              <p className="text-gray-400 mb-4">
                Enter a code from a friend to join their match.
              </p>

              <form onSubmit={handleJoinChallenge} className="space-y-4">
                <input
                  type="text"
                  value={joinInput}
                  onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
                  placeholder="Enter challenge code"
                  className="input text-center text-2xl font-mono tracking-widest"
                  maxLength={6}
                />

                {declinedBy && (
              <div className="bg-yellow-500/10 border border-yellow-600 rounded-lg p-4 mb-6">
                <p className="text-yellow-400">{declinedBy} declined your challenge.</p>
              </div>
            )}
            {challengeError && (
                  <p className="text-red-500 text-center">{challengeError}</p>
                )}

                <button
                  type="submit"
                  disabled={!joinInput.trim()}
                  className="btn btn-primary w-full py-4 text-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Join Challenge
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChallengePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    }>
      <ChallengeContent />
    </Suspense>
  );
}
