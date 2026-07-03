'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import { useCubePrefs } from '@/stores/cubePrefs';
import { TwistyCube } from '@/components/TwistyCube';
import { authApi, keybindingsApi, usersApi , type UserPreferences } from '@/lib/api';
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
  // Appearance controls stay locked until the server copy arrives — editing
  // unhydrated defaults is how "change one color and everything else
  // reverts" happened: the edit blocked hydration AND the next save wrote
  // defaults over the user's real settings.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [cubeColors, setCubeColors] = useState<Record<string, string>>(DEFAULT_CUBE_COLORS);
  const [cubeLogo, setCubeLogo] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState('');
  const [animationSpeed, setAnimationSpeed] = useState(DEFAULT_ANIMATION_SPEED);
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
      // A slow GET must never clobber edits the user already made while it
      // was in flight (controls are locked until loaded, but belt & braces).
      if (prefsDirtyRef.current) return;
      if (prefs.cubeColors) {
        const merged = { ...DEFAULT_CUBE_COLORS, ...prefs.cubeColors };
        useCubePrefs.getState().setColors(merged);
        setCubeColors(merged);
      }
      if (prefs.cubeLogo !== undefined) {
        useCubePrefs.getState().setLogo(prefs.cubeLogo ?? null);
        setCubeLogo(prefs.cubeLogo ?? null);
      }
      if (prefs.animationSpeed !== undefined) {
        setAnimationSpeed(prefs.animationSpeed);
        useCubePrefs.getState().setSpeed(prefs.animationSpeed);
      }
    }).catch(() => {
      // Failed to load — unlock with defaults rather than locking forever.
    }).finally(() => {
      setPrefsLoaded(true);
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

  // Debounced, single-flight, latest-wins preference saves. A color-picker
  // drag fires onChange dozens of times; firing a PUT per tick let concurrent
  // read-merge-write requests interleave on the server, so a STALE write
  // could land last and "revert" the user's pick. Instead: coalesce edits,
  // keep at most one request in flight, and always send the newest state.
  const prefsDirtyRef = useRef(false);
  const pendingPrefsRef = useRef<UserPreferences | null>(null);
  const prefsInFlightRef = useRef(false);
  const prefsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPreferences = async () => {
    if (prefsInFlightRef.current) return; // the in-flight finisher re-queues
    const body = pendingPrefsRef.current;
    if (!body || !accessToken) return;
    pendingPrefsRef.current = null;
    prefsInFlightRef.current = true;
    setIsSavingPrefs(true);
    try {
      await usersApi.updatePreferences(accessToken, body);
    } catch {
      // Re-queue what failed under anything newer, and surface it.
      pendingPrefsRef.current = { ...body, ...(pendingPrefsRef.current ?? {}) };
      setMessage('Failed to save preferences');
    } finally {
      prefsInFlightRef.current = false;
      setIsSavingPrefs(false);
      if (pendingPrefsRef.current) {
        prefsTimerRef.current = setTimeout(flushPreferences, 400);
      }
    }
  };

  const savePreferences = (prefs: UserPreferences) => {
    prefsDirtyRef.current = true;
    pendingPrefsRef.current = { ...(pendingPrefsRef.current ?? {}), ...prefs };
    if (prefsTimerRef.current) clearTimeout(prefsTimerRef.current);
    prefsTimerRef.current = setTimeout(flushPreferences, 400);
  };

  // Flush pending edits when leaving. Client-side route changes run the
  // unmount cleanup; HARD navigations (reload, typed URL, closed tab) do NOT
  // unmount React, so pagehide + fetch keepalive covers those — otherwise an
  // edit inside the debounce window would never reach the server and a later
  // hydration would revert it.
  useEffect(() => {
    const flushKeepalive = () => {
      const body = pendingPrefsRef.current;
      if (!body || !accessToken) return;
      pendingPrefsRef.current = null;
      fetch(`${API_BASE}/users/me/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener('pagehide', flushKeepalive);
    return () => {
      window.removeEventListener('pagehide', flushKeepalive);
      if (prefsTimerRef.current) clearTimeout(prefsTimerRef.current);
      flushKeepalive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // Cube color handlers
  const handleColorChange = (face: string, color: string) => {
    const newColors = { ...cubeColors, [face]: color };
    setCubeColors(newColors);
    const cubePrefs = useCubePrefs.getState();
    cubePrefs.setColors(newColors); // apply everywhere + localStorage
    cubePrefs.markModified(); // hydration must not revert this session's edits
    savePreferences({ cubeColors: newColors });
  };

  // Animation speed handler
  const handleAnimationSpeedChange = (speed: number) => {
    setAnimationSpeed(speed);
    const cubePrefs = useCubePrefs.getState();
    cubePrefs.setSpeed(speed);
    cubePrefs.markModified();
    savePreferences({ animationSpeed: speed });
  };

  const resetColorsToDefaults = () => {
    setCubeColors(DEFAULT_CUBE_COLORS);
    const cubePrefs = useCubePrefs.getState();
    cubePrefs.setColors(DEFAULT_CUBE_COLORS);
    cubePrefs.markModified();
    savePreferences({ cubeColors: DEFAULT_CUBE_COLORS });
    setMessage('Colors reset to defaults');
    setTimeout(() => setMessage(''), 3000);
  };

  // Cube logo: downscale client-side, upload to Imgur via the API, store URL.
  const handleLogoUpload = async (file: File | undefined | null) => {
    if (!file || !accessToken) return;
    setLogoError('');
    setLogoUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        const objUrl = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(objUrl);
          const SIZE = 256;
          const canvas = document.createElement('canvas');
          canvas.width = SIZE;
          canvas.height = SIZE;
          const ctx = canvas.getContext('2d')!;
          const scale = Math.min(SIZE / img.width, SIZE / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => {
          URL.revokeObjectURL(objUrl);
          reject(new Error('Could not read that image'));
        };
        img.src = objUrl;
      });

      const { url } = await usersApi.uploadLogo(accessToken, dataUrl);
      setCubeLogo(url);
      const cubePrefs = useCubePrefs.getState();
      cubePrefs.setLogo(url);
      cubePrefs.markModified();
      setMessage('Logo uploaded!');
      setTimeout(() => setMessage(''), 3000);
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setLogoUploading(false);
    }
  };

  const handleLogoRemove = () => {
    setCubeLogo(null);
    const cubePrefs = useCubePrefs.getState();
    cubePrefs.setLogo(null);
    cubePrefs.markModified();
    savePreferences({ cubeLogo: null });
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
              {!prefsLoaded && <span className="text-gray-500"> Loading your settings…</span>}
            </p>

            {/* Everything below edits preferences — locked until the saved
                copy has hydrated, so an early edit can't overwrite settings
                that simply hadn't loaded yet. */}
            <div className={prefsLoaded ? '' : 'pointer-events-none opacity-50'} aria-busy={!prefsLoaded}>
            {/* Live preview */}
            <div className="mb-6">
              <TwistyCube puzzleSize="3x3" scramble="" faceColors={cubeColors} logoUrl={cubeLogo} animationSpeed={animationSpeed} draggable className="h-72 md:h-96" />
              <p className="text-center text-xs text-gray-500 mt-2">Drag the cube to look around</p>
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

            {/* Cube Logo */}
            <div className="mt-8 pt-6 border-t border-gray-700">
              <h2 className="text-xl font-semibold mb-2">Cube Logo</h2>
              <p className="text-gray-400 mb-4">
                Like a real cube&apos;s brand sticker: upload an image and it appears on
                the center of your white face — everywhere your cube is shown, including
                on your opponents&apos; screens.
              </p>
              <div className="flex items-center gap-4">
                {cubeLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cubeLogo} alt="Cube logo" className="w-16 h-16 rounded border border-gray-600 object-contain bg-white" />
                ) : (
                  <div className="w-16 h-16 rounded border border-dashed border-gray-600 flex items-center justify-center text-gray-600 text-xs">
                    None
                  </div>
                )}
                <label className={`btn btn-secondary px-4 py-2 cursor-pointer ${logoUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  {logoUploading ? 'Uploading…' : cubeLogo ? 'Replace Logo' : 'Upload Logo'}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handleLogoUpload(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
                {cubeLogo && (
                  <button onClick={handleLogoRemove} className="text-red-400 hover:text-red-300 text-sm">
                    Remove
                  </button>
                )}
              </div>
              {logoError && <p className="text-red-400 text-sm mt-2">{logoError}</p>}
              <p className="text-gray-600 text-xs mt-2">Hosted on Imgur. Square images work best.</p>
            </div>

            {/* Animation Speed */}
            <div className="mt-8 pt-6 border-t border-gray-700">
              <h2 className="text-xl font-semibold mb-4">Animation Speed</h2>
              <p className="text-gray-400 mb-4">
                Control how fast cube turns animate — applies everywhere you solve.
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
