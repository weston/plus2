'use client';

import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';

export default function HomePage() {
  const { user } = useAuthStore();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="text-center max-w-4xl">
        {/* Logo */}
        <h1 className="text-7xl font-bold mb-4">
          <span className="text-blue-500">Plus</span>
          <span className="text-yellow-500">2</span>
        </h1>

        <p className="text-2xl text-gray-300 mb-8">
          Competitive Rubik&apos;s Cube Racing
        </p>

        <p className="text-lg text-gray-400 mb-12 max-w-2xl mx-auto">
          Race against players worldwide in real-time cube solving competitions.
          Climb the ranks, earn your league, and become a grandmaster.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-8">
          {user ? (
            <Link
              href="/dashboard"
              className="btn btn-primary text-xl px-8 py-4"
            >
              Enter Arena
            </Link>
          ) : (
            <>
              <Link
                href="/register"
                className="btn btn-primary text-xl px-8 py-4"
              >
                Get Started
              </Link>
              <Link
                href="/login"
                className="btn btn-secondary text-xl px-8 py-4"
              >
                Login
              </Link>
            </>
          )}
        </div>

        {/* Practice Mode Link */}
        <div className="mb-16">
          <Link
            href="/practice"
            className="text-blue-400 hover:text-blue-300 underline"
          >
            Or try Practice Mode →
          </Link>
        </div>

        {/* Features */}
        <div className="grid md:grid-cols-3 gap-8 text-left">
          <div className="card">
            <div className="text-4xl mb-4">🎮</div>
            <h3 className="text-xl font-semibold mb-2">Real-time Racing</h3>
            <p className="text-gray-400">
              Watch your opponent&apos;s cube in real-time as you race to solve first.
              Every move counts.
            </p>
          </div>

          <div className="card">
            <div className="text-4xl mb-4">🏆</div>
            <h3 className="text-xl font-semibold mb-2">Ranked Leagues</h3>
            <p className="text-gray-400">
              Climb from Bronze to Grandmaster with our ELO-based ranking system.
              Compete against players of similar skill.
            </p>
          </div>

          <div className="card">
            <div className="text-4xl mb-4">⌨️</div>
            <h3 className="text-xl font-semibold mb-2">Custom Controls</h3>
            <p className="text-gray-400">
              Configure your keybindings to match your preferred solving style.
              More puzzle sizes coming soon.
            </p>
          </div>
        </div>

        {/* Puzzle sizes */}
        <div className="mt-16">
          <p className="text-gray-400 mb-4">Supported Puzzles</p>
          <div className="flex justify-center gap-4">
            {['2x2', '3x3', '4x4', '5x5'].map((size) => {
              const isAvailable = size === '3x3';
              return (
                <div
                  key={size}
                  className={`w-16 h-16 flex flex-col items-center justify-center rounded-lg border font-bold ${
                    isAvailable
                      ? 'bg-blue-600/20 border-blue-500 text-white'
                      : 'bg-gray-800/50 border-gray-700 text-gray-500'
                  }`}
                >
                  <span>{size}</span>
                  {!isAvailable && <span className="text-[10px] text-gray-600">Soon</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
