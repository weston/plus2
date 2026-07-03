'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { useCubePrefs } from '@/stores/cubePrefs';
import { TwistyCube } from '@/components/TwistyCube';
import { authApi, keybindingsApi, usersApi } from '@/lib/api';
import { ALL_MOVES, DEFAULT_KEYBINDINGS } from '@plus2/shared';
import { CountryFlag, COUNTRIES } from '@/components/CountryFlag';

type SettingsTab = 'controls' | 'appearance' | 'account';

interface KeybindingProfile {
  id: string;
  name: string;
  isActive: boolean;
  bindings: Record<string, string>;
}

// Default cube face colors
const DEFAULT_CUBE_COLORS: Record<string, string> = {
  U: '#FFFFFF', // White
  D: '#FFFF00', // Yellow
  F: '#00FF00', // Green
  B: '#0000FF', // Blue
  R: '#FF0000', // Red
  L: '#FFA500', // Orange
};

const DEFAULT_ANIMATION_SPEED = 3;
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

export default function SettingsPage() {
  const router = useRouter();
  const { user, accessToken, logout, _hasHydrated } = useAuthStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('controls');

  // Keybindings state
  const [profiles, setProfiles] = useState<KeybindingProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<KeybindingProfile | null>(null);
  const [editingMove, setEditingMove] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Appearance state
  const [cubeColors, setCubeColors] = useState<Record<string, string>>(DEFAULT_CUBE_COLORS);
  const [animationSpeed, setAnimationSpeed] = useState(DEFAULT_ANIMATION_SPEED);
  const [ghostOptOut, setGhostOptOut] = useState(false);
  const [isSavingPrefs, setIsSavingPrefs] = useState(false);

  // Account state
  const [country, setCountry] = useState<string>('');
  const [connections, setConnections] = useState<{ google: boolean; wca: boolean; wcaId: string | null } | null>(null);
  const [linkMessage, setLinkMessage] = useState('');

  // Load linked providers + handle the link-callback query (?linked / ?error).
  useEffect(() => {
    if (!accessToken) return;
    const refresh = () => usersApi.getConnections(accessToken).then(setConnections).catch(() => {});
    refresh();
    const params = new URLSearchParams(window.location.search);
    if (params.get('linked')) {
      setLinkMessage(`${params.get('linked') === 'wca' ? 'WCA' : 'Google'} account linked!`);
      setActiveTab('account');
      window.history.replaceState({}, '', '/settings');
    } else if (params.get('error') === 'link_conflict') {
      setLinkMessage('That account is already linked to a different user.');
      setActiveTab('account');
      window.history.replaceState({}, '', '/settings');
    }
  }, [accessToken]);

  const handleLink = async (provider: 'google' | 'wca') => {
    if (!accessToken) return;
    try {
      const { token } = await authApi.getLinkToken(accessToken);
      window.location.href = `${API_BASE}/auth/${provider}?state=${encodeURIComponent(token)}`;
    } catch {
      setLinkMessage('Could not start linking. Please try again.');
    }
  };

  // Redirect if not logged in (wait for hydration first)
  useEffect(() => {
    if (_hasHydrated && (!user || !accessToken)) {
      router.push('/login');
    }
  }, [user, accessToken, router, _hasHydrated]);

  // Load profiles
  useEffect(() => {
    if (!accessToken) return;

    keybindingsApi.getProfiles(accessToken).then((data) => {
      setProfiles(data);
      const active = data.find((p) => p.isActive);
      if (active) setActiveProfile(active);
    }).catch(() => {
      // Failed to load keybinding profiles; leave existing state as-is
    });
  }, [accessToken]);

  // Load preferences from server
  useEffect(() => {
    if (!accessToken) return;

    usersApi.getPreferences(accessToken).then((prefs) => {
      if (prefs.cubeColors) {
        useCubePrefs.getState().setColors({ ...DEFAULT_CUBE_COLORS, ...(prefs.cubeColors || {}) });
      setCubeColors({ ...DEFAULT_CUBE_COLORS, ...prefs.cubeColors });
      }
      if (prefs.animationSpeed !== undefined) {
        setAnimationSpeed(prefs.animationSpeed);
      }
      if (prefs.ghostOptOut !== undefined) {
        setGhostOptOut(prefs.ghostOptOut);
      }
    }).catch(() => {
      // Failed to load preferences, use defaults
    });

    // Load user profile for country
    usersApi.getMe(accessToken).then((profile) => {
      if (profile.country) {
        setCountry(profile.country);
      }
    }).catch(() => {});
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

  const resetBindingsToDefaults = async () => {
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

  // Save preferences to server
  const handleGhostOptOutChange = (optOut: boolean) => {
    setGhostOptOut(optOut);
    savePreferences({ ghostOptOut: optOut });
  };

  const savePreferences = async (prefs: { animationSpeed?: number; cubeColors?: Record<string, string>; ghostOptOut?: boolean }) => {
    if (!accessToken) return;
    setIsSavingPrefs(true);
    try {
      await usersApi.updatePreferences(accessToken, prefs);
    } catch {
      setMessage('Failed to save preferences');
    } finally {
      setIsSavingPrefs(false);
    }
  };

  // Cube color handlers
  const handleColorChange = (face: string, color: string) => {
    const newColors = { ...cubeColors, [face]: color };
    setCubeColors(newColors);
    useCubePrefs.getState().setColors(newColors); // apply everywhere + localStorage
    savePreferences({ cubeColors: newColors });
  };

  // Animation speed handler
  const handleAnimationSpeedChange = (speed: number) => {
    setAnimationSpeed(speed);
    savePreferences({ animationSpeed: speed });
  };

  const resetColorsToDefaults = () => {
    setCubeColors(DEFAULT_CUBE_COLORS);
    useCubePrefs.getState().setColors(DEFAULT_CUBE_COLORS);
    savePreferences({ cubeColors: DEFAULT_CUBE_COLORS });
    setMessage('Colors reset to defaults');
    setTimeout(() => setMessage(''), 3000);
  };

  const handleCountryChange = async (newCountry: string) => {
    if (!accessToken) return;
    setCountry(newCountry);
    try {
      await usersApi.updateCountry(accessToken, newCountry);
      setMessage('Country updated!');
      setTimeout(() => setMessage(''), 3000);
    } catch {
      setMessage('Failed to update country');
    }
  };

  const handleLogout = () => {
    logout();
    router.push('/');
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

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'controls', label: 'Controls' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'account', label: 'Account' },
  ];

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

        {/* Tab Navigation */}
        <div className="flex gap-1 mb-6 bg-gray-900 p-1 rounded-lg">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2 px-4 rounded-md font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {message && (
          <div className={`mb-4 p-3 rounded ${
            message.includes('Failed') ? 'bg-red-900/50' : 'bg-green-900/50'
          }`}>
            {message}
          </div>
        )}

        {/* Controls Tab */}
        {activeTab === 'controls' && (
          <div className="card">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold">Keybindings</h2>
              <div className="flex gap-2">
                <button
                  onClick={resetBindingsToDefaults}
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
        )}

        {/* Appearance Tab */}
        {activeTab === 'appearance' && (
          <div className="card">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold">Cube Colors</h2>
              <button
                onClick={resetColorsToDefaults}
                className="btn btn-secondary text-sm"
              >
                Reset to Defaults
              </button>
            </div>

            <p className="text-gray-400 mb-6">
              Customize the colors of each face of the cube.
            </p>

            {/* Live preview */}
            <div className="mb-6">
              <TwistyCube puzzleSize="3x3" scramble="" faceColors={cubeColors} className="h-40" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {Object.entries(cubeColors).map(([face, color]) => (
                <div key={face} className="bg-gray-800 p-4 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold">
                      {face === 'U' && 'Top (U)'}
                      {face === 'D' && 'Bottom (D)'}
                      {face === 'F' && 'Front (F)'}
                      {face === 'B' && 'Back (B)'}
                      {face === 'R' && 'Right (R)'}
                      {face === 'L' && 'Left (L)'}
                    </span>
                    <div
                      className="w-8 h-8 rounded border-2 border-gray-600"
                      style={{ backgroundColor: color }}
                    />
                  </div>
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => handleColorChange(face, e.target.value)}
                    className="w-full h-10 rounded cursor-pointer bg-transparent"
                  />
                </div>
              ))}
            </div>

            {/* Animation Speed */}
            <div className="mt-8 pt-6 border-t border-gray-700">
              <h2 className="text-xl font-semibold mb-4">Animation Speed</h2>
              <p className="text-gray-400 mb-4">
                Control how fast cube moves animate during practice.
              </p>
              <div className="bg-gray-800 p-4 rounded-lg">
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={animationSpeed}
                  onChange={(e) => handleAnimationSpeedChange(parseFloat(e.target.value))}
                  className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-sm text-gray-400 mt-2">
                  <span>Slow</span>
                  <span className="text-white font-medium">
                    {animationSpeed <= 0 ? 'Slowest' : animationSpeed >= 10 ? 'Fastest' : `${animationSpeed}x`}
                  </span>
                  <span>Fast</span>
                </div>
              </div>
            </div>

            {/* Ghost contribution */}
            <div className="mt-8 pt-6 border-t border-gray-700">
              <h2 className="text-xl font-semibold mb-4">Ghost Races</h2>
              <label className="flex items-start gap-3 cursor-pointer bg-gray-800 p-4 rounded-lg">
                <input
                  type="checkbox"
                  className="mt-1 accent-blue-500 w-4 h-4"
                  checked={!ghostOptOut}
                  onChange={(e) => handleGhostOptOutChange(!e.target.checked)}
                />
                <span>
                  <span className="block font-medium">Contribute my solves as ghosts</span>
                  <span className="block text-sm text-gray-400">
                    When on, your ranked race solves can be raced by other players as ghost
                    opponents. This helps everyone always have someone to race.
                  </span>
                </span>
              </label>
            </div>

            {isSavingPrefs && (
              <div className="mt-4 text-sm text-gray-400">Saving...</div>
            )}
          </div>
        )}

        {/* Account Tab */}
        {activeTab === 'account' && (
          <div className="space-y-6">
            <div className="card">
              <h2 className="text-xl font-semibold mb-6">Account Information</h2>

              <div className="space-y-4">
                <div className="flex justify-between items-center py-3 border-b border-gray-700">
                  <span className="text-gray-400">Username</span>
                  <span className="font-semibold">{user.username}</span>
                </div>
                <div className="flex justify-between items-center py-3 border-b border-gray-700">
                  <span className="text-gray-400">Email</span>
                  <span>{user.email}</span>
                </div>
                <div className="flex justify-between items-center py-3 border-b border-gray-700">
                  <span className="text-gray-400">Current League</span>
                  <span className="font-semibold capitalize">{user.league}</span>
                </div>
                <div className="flex justify-between items-center py-3">
                  <span className="text-gray-400">MMR</span>
                  <span className="font-semibold">{user.mmr}</span>
                </div>
              </div>
            </div>

            <div className="card">
              <h2 className="text-xl font-semibold mb-2">Connected Accounts</h2>
              <p className="text-gray-400 mb-4">
                Link Google and WCA so you can sign in with either &mdash; they&apos;ll be the same account.
              </p>
              {linkMessage && <div className="mb-4 text-sm text-blue-400">{linkMessage}</div>}
              <div className="space-y-3">
                <div className="flex justify-between items-center py-2 border-b border-gray-700">
                  <span className="flex items-center gap-2 font-medium">Google</span>
                  {connections?.google ? (
                    <span className="text-green-400 text-sm">&#10003; Linked</span>
                  ) : (
                    <button onClick={() => handleLink('google')} className="btn btn-secondary text-sm py-1 px-4">Link</button>
                  )}
                </div>
                <div className="flex justify-between items-center py-2">
                  <span className="flex items-center gap-2 font-medium">
                    WCA{connections?.wcaId && <span className="text-xs text-gray-500">({connections.wcaId})</span>}
                  </span>
                  {connections?.wca ? (
                    <span className="text-green-400 text-sm">&#10003; Linked</span>
                  ) : (
                    <button onClick={() => handleLink('wca')} className="btn btn-secondary text-sm py-1 px-4">Link</button>
                  )}
                </div>
              </div>
            </div>

            <div className="card">
              <h2 className="text-xl font-semibold mb-6">Country</h2>
              <p className="text-gray-400 mb-4">
                Select your country to display a flag on your profile and in matches.
              </p>
              <div className="flex items-center gap-4">
                <CountryFlag country={country} size="lg" />
                <select
                  value={country}
                  onChange={(e) => handleCountryChange(e.target.value)}
                  className="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select a country</option>
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="card">
              <h2 className="text-xl font-semibold mb-6">Danger Zone</h2>

              <button
                onClick={handleLogout}
                className="btn btn-danger"
              >
                Log Out
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
