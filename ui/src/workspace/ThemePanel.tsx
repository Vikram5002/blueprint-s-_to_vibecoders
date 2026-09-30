import { useState } from 'react';
import {
  DEFAULT_THEME,
  FONTS,
  FONT_NAMES,
  PRESETS,
  contrastGrade,
  contrastRatio,
  isDark,
  randomTheme,
  themeAsCss,
  themeAsTailwind,
  toggleDark,
  type FontName,
  type PageTheme,
} from './page-theme';
import type { DesignToken } from './page-builder-types';

interface ThemePanelProps {
  readonly theme: PageTheme | undefined;
  readonly onChange: (theme: PageTheme | undefined) => void;
}

const COLOR_ROLES: readonly { readonly key: DesignToken; readonly label: string }[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'success', label: 'Success' },
  { key: 'warning', label: 'Warning' },
  { key: 'danger', label: 'Danger' },
  { key: 'neutral', label: 'Neutral' },
];

const SURFACE_ROLES: readonly {
  readonly key: 'background' | 'text' | 'muted' | 'surface' | 'line';
  readonly label: string;
}[] = [
  { key: 'background', label: 'Background' },
  { key: 'text', label: 'Text' },
  { key: 'muted', label: 'Muted' },
  { key: 'surface', label: 'Cards' },
  { key: 'line', label: 'Borders' },
];

function Grade({
  label,
  a,
  b,
}: {
  readonly label: string;
  readonly a: string;
  readonly b: string;
}): JSX.Element {
  const ratio = contrastRatio(a, b);
  const grade = contrastGrade(ratio);
  const tone =
    grade === 'Fail'
      ? 'text-red-300 border-red-800'
      : grade === 'AA large'
        ? 'text-amber-300 border-amber-800'
        : 'text-emerald-300 border-emerald-800';
  return (
    <span
      data-testid={`contrast-${label}`}
      className={`rounded border px-1.5 py-0.5 text-[10px] ${tone}`}
      title={`${ratio.toFixed(2)}:1`}
    >
      {label} {ratio.toFixed(1)} · {grade}
    </span>
  );
}

function ColorInput({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (hex: string) => void;
}): JSX.Element {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 w-7 cursor-pointer rounded border border-slate-700 bg-transparent"
      />
      <span className="w-16">{label}</span>
      <span className="font-mono text-[10px] text-slate-500">{value}</span>
    </label>
  );
}

/**
 * Realtime-Colors-style theming for a page: presets, a "shuffle" for a random
 * harmonious palette and font pairing, light/dark, every colour editable,
 * live WCAG contrast grades, and export as CSS variables or a Tailwind config.
 */
export function ThemePanel({ theme, onChange }: ThemePanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const t = theme ?? DEFAULT_THEME;
  const set = (patch: Partial<PageTheme>): void => onChange({ ...t, ...patch });
  const copy = (what: string, text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(what));
  };
  const button =
    'rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800';

  return (
    <div className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="toggle-theme"
          onClick={() => setOpen(!open)}
          className={`${button} ${open ? 'border-sky-600 text-sky-300' : ''}`}
        >
          🎨 Theme
        </button>
        <span className="flex gap-0.5" aria-hidden>
          {[t.colors.primary, t.colors.secondary, t.background, t.text, t.surface].map((c, i) => (
            <span
              key={i}
              className="h-4 w-4 rounded-sm border border-slate-700"
              style={{ backgroundColor: c }}
            />
          ))}
        </span>
        <button
          type="button"
          data-testid="shuffle-theme"
          onClick={() => onChange(randomTheme(t))}
          title="Random harmonious palette and fonts"
          className={button}
        >
          ⤮ Shuffle
        </button>
        <button
          type="button"
          data-testid="toggle-dark"
          onClick={() => onChange(toggleDark(t))}
          className={button}
        >
          {isDark(t) ? '☀ Light' : '☾ Dark'}
        </button>
        {theme !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className={`${button} text-slate-400`}
          >
            Reset
          </button>
        )}
      </div>

      {open && (
        <div
          data-testid="theme-panel"
          className="mt-2 grid gap-4 rounded-lg border border-slate-800 bg-slate-900/70 p-3 lg:grid-cols-[1fr_1fr_1fr]"
        >
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Presets
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => onChange(preset.name === 'Default' ? undefined : preset.theme)}
                  className={`${button} flex items-center gap-1.5`}
                >
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: preset.theme.colors.primary }}
                  />
                  <span
                    className="h-3 w-3 rounded-full border border-slate-600"
                    style={{ backgroundColor: preset.theme.background }}
                  />
                  {preset.name}
                </button>
              ))}
            </div>
            <div className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Fonts
            </div>
            {(['headingFont', 'bodyFont'] as const).map((field) => (
              <label key={field} className="flex items-center gap-2 text-[11px] text-slate-300">
                <span className="w-14">{field === 'headingFont' ? 'Headings' : 'Body'}</span>
                <select
                  data-testid={`font-${field}`}
                  value={t[field]}
                  onChange={(event) => set({ [field]: event.target.value as FontName })}
                  className="flex-1 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px] text-slate-100"
                >
                  {FONT_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {FONTS[name].label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Brand colours
            </div>
            {COLOR_ROLES.map(({ key, label }) => (
              <ColorInput
                key={key}
                label={label}
                value={t.colors[key]}
                onChange={(hex) => set({ colors: { ...t.colors, [key]: hex } })}
              />
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Page
            </div>
            {SURFACE_ROLES.map(({ key, label }) => (
              <ColorInput
                key={key}
                label={label}
                value={t[key]}
                onChange={(hex) => set({ [key]: hex })}
              />
            ))}
            <div className="flex flex-wrap gap-1 pt-1">
              <Grade label="Text" a={t.text} b={t.background} />
              <Grade label="Muted" a={t.muted} b={t.background} />
              <Grade label="Button" a="#ffffff" b={t.colors.primary} />
            </div>
            <div className="flex gap-1.5 pt-1">
              <button type="button" onClick={() => copy('CSS', themeAsCss(t))} className={button}>
                Copy CSS
              </button>
              <button
                type="button"
                onClick={() => copy('Tailwind', themeAsTailwind(t))}
                className={button}
              >
                Copy Tailwind
              </button>
              {copied !== null && (
                <span className="self-center text-[10px] text-emerald-300">{copied} copied</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
