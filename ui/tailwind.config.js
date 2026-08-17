/** @type {import('tailwindcss').Config} */
export const config = {
  // Scoped to workspace/ only — the existing blueprint dashboard (App.tsx and
  // friends) keeps its own hand-written styles.css and is not touched here.
  content: ['./workspace.html', './src/workspace/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
