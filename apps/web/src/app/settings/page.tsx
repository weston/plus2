'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { keybindingsApi } from '@/lib/api';
import { ALL_MOVES, DEFAULT_KEYBINDINGS } from '@plus2/shared';

interface KeybindingProfile {
  id: string;
  name: string;
  isActive: boolean;
  bindings: Record<string, string>;
}

export default function SettingsPage() {
  const router = useRouter();
  const { user, accessToken } = useAuthStore();
  const [profiles, setProfiles] = useState<KeybindingProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<KeybindingProfile | null>(null);
  const [editingMove, setEditingMove] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Redirect if not logged in
  useEffect(() => {
    if (!user || !accessToken) {
      router.push('/login');
    }
  }, [user, accessToken, router]);

  // Load profiles
  useEffect(() => {
    if (!accessToken) return;

    keybindingsApi.getProfiles(accessToken).then((data) => {
      setProfiles(data);
      const active = data.find((p) => p.isActive);
      if (active) setActiveProfile(active);
    });
  }, [accessToken]);

  const handleKeyCapture = (e: KeyboardEvent) => {
    if (!editingMove || !activeProfile) return;

    e.preventDefault();
    const key = e.key.toLowerCase();

    // Check for conflicts
    const conflictingMove = Object.entries(activeProfile.bindings).find(
      ([move, boundKey]) => boundKey === key && move !== editingMove
    );

    if (conflictingMove) {
      setMessage(`Key "${key}" is already bound to ${conflictingMove[0]}`);
      return;
    }

    // Update binding
    const newBindings = {
      ...activeProfile.bindings,
      [editingMove]: key,
    };

    setActiveProfile({ ...activeProfile, bindings: newBindings });
    setEditingMove(null);
    setMessage('');
  };

  useEffect(() => {
    if (editingMove) {
      window.addEventListener('keydown', handleKeyCapture);
      return () => window.removeEventListener('keydown', handleKeyCapture);
    }
  }, [editingMove, activeProfile]);

  const saveBindings = async () => {
    if (!activeProfile || !accessToken) return;

    setIsSaving(true);
    try {
      await keybindingsApi.updateProfile(accessToken, activeProfile.id, {
        bindings: activeProfile.bindings,
      });
      setMessage('Keybindings saved!');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage('Failed to save keybindings');
    } finally {
      setIsSaving(false);
    }
  };

  const resetToDefaults = async () => {
    if (!activeProfile || !accessToken) return;

    try {
      const updated = await keybindingsApi.reset(accessToken, activeProfile.id);
      setActiveProfile(updated as KeybindingProfile);
      setMessage('Reset to defaults');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage('Failed to reset');
    }
  };

  if (!user) return null;

  // Group moves by type
  const faceRMoves = ALL_MOVES.filter((m) => m.startsWith('R'));
  const faceLMoves = ALL_MOVES.filter((m) => m.startsWith('L'));
  const faceUMoves = ALL_MOVES.filter((m) => m.startsWith('U'));
  const faceDMoves = ALL_MOVES.filter((m) => m.startsWith('D'));
  const faceFMoves = ALL_MOVES.filter((m) => m.startsWith('F'));
  const faceBMoves = ALL_MOVES.filter((m) => m.startsWith('B'));
  const sliceMoves = ALL_MOVES.filter((m) => ['M', 'E', 'S'].some((s) => m.startsWith(s)));
  const rotations = ALL_MOVES.filter((m) => ['x', 'y', 'z'].some((s) => m.startsWith(s)));

  const renderMoveGroup = (title: string, moves: readonly string[]) => (
    <div className="mb-6">
      <h4 className="text-sm font-semibold text-gray-400 mb-2">{title}</h4>
      <div className="grid grid-cols-3 gap-2">
        {moves.map((move) => (
          <div
            key={move}
            onClick={() => setEditingMove(move)}
            className={`flex items-center justify-between p-2 rounded cursor-pointer transition-all ${
              editingMove === move
                ? 'bg-blue-600 ring-2 ring-blue-400'
                : 'bg-gray-800 hover:bg-gray-700'
            }`}
          >
            <span className="font-mono">{move}</span>
            <span className="key-badge">
              {editingMove === move
                ? '...'
                : activeProfile?.bindings[move] || '-'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <header className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="text-gray-400 hover:text-white">
              ← Back
            </Link>
            <h1 className="text-2xl font-bold">Settings</h1>
          </div>
        </header>

        {/* Keybindings */}
        <div className="card">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold">Keybindings</h2>
            <div className="flex gap-2">
              <button
                onClick={resetToDefaults}
                className="btn btn-secondary text-sm"
              >
                Reset to Defaults
              </button>
              <button
                onClick={saveBindings}
                disabled={isSaving}
                className="btn btn-primary text-sm"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>

          {message && (
            <div className={`mb-4 p-3 rounded ${
              message.includes('Failed') ? 'bg-red-900/50' : 'bg-green-900/50'
            }`}>
              {message}
            </div>
          )}

          <p className="text-gray-400 mb-6">
            Click on a move to change its keybinding, then press the new key.
          </p>

          <div className="grid md:grid-cols-2 gap-6">
            <div>
              {renderMoveGroup('Right Face (R)', faceRMoves)}
              {renderMoveGroup('Left Face (L)', faceLMoves)}
              {renderMoveGroup('Up Face (U)', faceUMoves)}
            </div>
            <div>
              {renderMoveGroup('Down Face (D)', faceDMoves)}
              {renderMoveGroup('Front Face (F)', faceFMoves)}
              {renderMoveGroup('Back Face (B)', faceBMoves)}
            </div>
          </div>

          <div className="border-t border-gray-700 pt-6 mt-6">
            <div className="grid md:grid-cols-2 gap-6">
              {renderMoveGroup('Slice Moves', sliceMoves)}
              {renderMoveGroup('Rotations', rotations)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
