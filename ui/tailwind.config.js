/**
 * The workspace's Tailwind palette, remapped onto the shared design system
 * (src/design/theme.css) so every existing class - bg-slate-900, text-sky-300,
 * border-emerald-700, ... - lands on Apple's dark system colours without
 * rewriting each component:
 *
 * - `slate` becomes neutral greys (no blue cast), matching macOS dark surfaces.
 * - `sky`, `emerald`, `red`, `amber`, `violet` become ramps around the system
 *   blue, green, red, orange and purple.
 * - Radii step up a notch and the sans stack prefers the platform UI font.
 *
 * @type {import('tailwindcss').Config}
 */
export const config = {
  // Scoped to workspace/ and the shared design components - the blueprint
  // dashboard (App.tsx and friends) keeps its own hand-written styles.css.
  content: ['./workspace.html', './src/workspace/**/*.{ts,tsx}', './src/design/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slate: {
          50: '#f5f5f7',
          100: '#e8e8ed',
          200: '#d2d2d7',
          300: '#aeaeb2',
          400: '#8e8e93',
          500: '#6e6e73',
          600: '#48484a',
          700: '#38383c',
          800: '#26262a',
          900: '#151517',
          950: '#0c0c0e',
        },
        sky: {
          50: '#eaf4ff',
          100: '#cfe6ff',
          200: '#a3d0ff',
          300: '#70b7ff',
          400: '#409cff',
          500: '#0a84ff',
          600: '#0071e3',
          700: '#0a5cb8',
          800: '#0b4585',
          900: '#0a2f59',
          950: '#061c38',
        },
        emerald: {
          50: '#eafbf0',
          100: '#c9f5d8',
          200: '#98ebb4',
          300: '#63df8f',
          400: '#3dd672',
          500: '#30d158',
          600: '#26ab48',
          700: '#1e8139',
          800: '#175c2a',
          900: '#0f3d1c',
          950: '#082611',
        },
        red: {
          50: '#fff0ef',
          100: '#ffd8d5',
          200: '#ffb0aa',
          300: '#ff8a82',
          400: '#ff6a61',
          500: '#ff453a',
          600: '#dc3429',
          700: '#ab281f',
          800: '#7a1d16',
          900: '#4f130e',
          950: '#300b08',
        },
        amber: {
          50: '#fff6e6',
          100: '#ffe8bf',
          200: '#ffd28a',
          300: '#ffbd55',
          400: '#ffad2b',
          500: '#ff9f0a',
          600: '#d98300',
          700: '#a86500',
          800: '#774800',
          900: '#4d2f00',
          950: '#2e1c00',
        },
        violet: {
          50: '#f8efff',
          100: '#eed8fc',
          200: '#dfb3fa',
          300: '#d08df7',
          400: '#c671f5',
          500: '#bf5af2',
          600: '#9c43cc',
          700: '#77339c',
          800: '#55256f',
          900: '#371847',
          950: '#210e2b',
        },
        indigo: {
          50: '#efefff',
          100: '#d9d9fb',
          200: '#b4b3f6',
          300: '#908ef1',
          400: '#7573ec',
          500: '#5e5ce6',
          600: '#4846c4',
          700: '#37359a',
          800: '#27266f',
          900: '#1a1948',
          950: '#0f0f2c',
        },
      },
      borderRadius: {
        DEFAULT: '7px',
        md: '9px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          'Inter',
          'Roboto',
          'sans-serif',
        ],
        mono: ['ui-monospace', '"SF Mono"', '"Cascadia Code"', 'Menlo', 'Consolas', 'monospace'],
      },
      transitionTimingFunction: {
        apple: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
