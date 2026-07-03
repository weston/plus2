'use client';

import { useEffect, useState } from 'react';

type ThemeId = 'premium' | 'glass' | 'minimal' | 'neon';

const THEMES: { id: ThemeId; label: string; swatch: string }[] = [
  { id: 'premium', label: 'Premium', swatch: '#7c5cff' },
  { id: 'glass', label: 'Glass', swatch: '#22d3ee' },
  { id: 'minimal', label: 'Minimal', swatch: '#c7f94b' },
  { id: 'neon', label: 'Neon', swatch: '#00e5ff' },
];

const STORAGE_KEY = 'plus2-theme';

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>('premium');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Validate the stored value against the known theme ids — a corrupt or
    // legacy value would otherwise be stamped onto data-theme and yield an
    // unstyled theme. Fall back to the default when it isn't recognized.
    const stored = localStorage.getItem(STORAGE_KEY);
    const saved: ThemeId = THEMES.some((t) => t.id === stored) ? (stored as ThemeId) : 'premium';
    setTheme(saved);
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  const apply = (id: ThemeId) => {
    setTheme(id);
    document.documentElement.setAttribute('data-theme', id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  return (
    <div className="fixed bottom-4 right-4 z-50 select-none">
      {open && (
        <div
          className="mb-2 w-44 rounded-xl border p-1.5 shadow-2xl"
          style={{
            background: 'var(--card-bg)',
            borderColor: 'var(--card-border)',
            backdropFilter: 'var(--card-blur)',
            WebkitBackdropFilter: 'var(--card-blur)' as unknown as string,
          }}
        >
          <p className="px-3 pb-1.5 pt-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            Theme (preview)
          </p>
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => apply(t.id)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-white/5"
              style={t.id === theme ? { background: 'rgba(255,255,255,0.08)' } : undefined}
            >
              <span className="h-3.5 w-3.5 rounded-full ring-1 ring-white/20" style={{ background: t.swatch }} />
              <span style={{ color: 'var(--text)' }}>{t.label}</span>
              {t.id === theme && (
                <span className="ml-auto text-xs" style={{ color: 'var(--accent)' }}>
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium shadow-xl transition-transform hover:scale-105"
        style={{
          background: 'var(--card-bg)',
          borderColor: 'var(--card-border)',
          color: 'var(--text)',
          backdropFilter: 'var(--card-blur)',
          WebkitBackdropFilter: 'var(--card-blur)' as unknown as string,
        }}
        title="Switch theme"
      >
        <span
          className="h-3 w-3 rounded-full"
          style={{ background: current.swatch, boxShadow: `0 0 8px ${current.swatch}` }}
        />
        {current.label}
      </button>
    </div>
  );
}
