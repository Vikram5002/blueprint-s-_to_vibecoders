/**
 * Makes a downloaded project runnable, not only buildable.
 *
 * The generated project is verified with ONE `tsc` over backend and frontend
 * (assemble.ts): that proves the frontend compiles, but a browser cannot load
 * `.tsx` - there was no `index.html`, no bundler and no script to start one,
 * so an unzipped project's UI could not be opened at all (found live,
 * 2026-09-27).
 *
 * Added at download time only, never to the project the pipeline builds and
 * verifies: the verified build stays exactly what it was (and code-model
 * capture is unaffected), while the zip gains the few files a person needs:
 *
 *   - `frontend/index.html` with the `#root` that `frontend/src/main.tsx` mounts into;
 *   - `vite.config.mjs`, serving `frontend/` and proxying `/api` to the backend on :3000;
 *   - `web` / `web:build` scripts and the two Vite dev dependencies in `package.json`;
 *   - a README with the exact commands.
 *
 * A file the project already has is never overwritten.
 */
export interface ZipEntry {
  readonly path: string;
  readonly contents: string;
}

export const FRONTEND_ENTRY = 'frontend/src/main.tsx';
export const VITE_VERSION = '^5.4.10';
export const VITE_REACT_PLUGIN_VERSION = '^4.3.3';

export function withRunScaffold(entries: readonly ZipEntry[], title = 'Generated app'): readonly ZipEntry[] {
  const paths = new Set(entries.map((entry) => entry.path));
  const hasFrontend = paths.has(FRONTEND_ENTRY);
  const hasBackend = paths.has('backend/src/index.ts');

  const patched = entries.map((entry) =>
    entry.path === 'package.json' ? { ...entry, contents: patchPackageJson(entry.contents, hasFrontend, hasBackend) } : entry,
  );
  const added: ZipEntry[] = [];
  const add = (entry: ZipEntry): void => {
    if (!paths.has(entry.path)) added.push(entry);
  };

  if (hasFrontend) {
    add({ path: 'frontend/index.html', contents: indexHtml(title) });
    add({ path: 'vite.config.mjs', contents: VITE_CONFIG });
  }
  add({ path: 'dev.mjs', contents: DEV_SCRIPT });
  add({ path: 'README.md', contents: readme(title, hasBackend, hasFrontend, paths.has('generated.blueprint')) });
  add({ path: '.gitignore', contents: 'node_modules/\ndist/\n*.db\n' });
  return [...patched, ...added];
}

function patchPackageJson(contents: string, hasFrontend: boolean, hasBackend: boolean): string {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(contents) as Record<string, unknown>;
  } catch {
    return contents;
  }
  const scripts = { ...(manifest['scripts'] as Record<string, string> | undefined) };
  scripts['dev'] ??= 'node dev.mjs';
  const devDependencies = { ...(manifest['devDependencies'] as Record<string, string> | undefined) };
  if (hasFrontend) {
    scripts['web'] ??= 'vite';
    scripts['web:build'] ??= 'vite build';
    if (hasBackend) scripts['serve'] ??= 'npm run build && npm run web:build && npm start';
    devDependencies['vite'] ??= VITE_VERSION;
    devDependencies['@vitejs/plugin-react'] ??= VITE_REACT_PLUGIN_VERSION;
  }
  return `${JSON.stringify({ ...manifest, scripts, devDependencies }, null, 2)}\n`;
}

/**
 * `npm run dev`: build once, then the API (port 3000) and the site (Vite, port
 * 5173, forwarding /api) side by side in one terminal, and the browser opened.
 * Ctrl+C stops both. Plain Node, so it adds no dependency.
 */
const DEV_SCRIPT = [
  "import { spawn, spawnSync } from 'node:child_process';",
  "import { existsSync } from 'node:fs';",
  '',
  'const node = process.execPath;',
  "const built = spawnSync(node, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });",
  'if (built.status !== 0) process.exit(built.status ?? 1);',
  '',
  'const children = [];',
  "if (existsSync('dist/backend/src/index.js')) children.push(spawn(node, ['dist/backend/src/index.js'], { stdio: 'inherit' }));",
  "if (existsSync('frontend/index.html')) children.push(spawn(node, ['node_modules/vite/bin/vite.js', '--open'], { stdio: 'inherit' }));",
  "else console.log('API running on http://localhost:3000');",
  '',
  'const stop = () => {',
  '  for (const child of children) child.kill();',
  '  process.exit(0);',
  '};',
  "process.on('SIGINT', stop);",
  "process.on('SIGTERM', stop);",
  "for (const child of children) child.on('exit', (code) => { if (code) stop(); });",
  '',
].join('\n');

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function indexHtml(title: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${escapeHtml(title)}</title>`,
    '    <style>body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }</style>',
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

const VITE_CONFIG = [
  "import { defineConfig } from 'vite';",
  "import react from '@vitejs/plugin-react';",
  '',
  '// Serves frontend/ and forwards /api calls to the backend (npm start, port 3000).',
  'export default defineConfig({',
  "  root: 'frontend',",
  '  plugins: [react()],',
  "  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },",
  "  build: { outDir: '../dist/web', emptyOutDir: true },",
  '});',
  '',
].join('\n');

function readme(title: string, hasBackend: boolean, hasFrontend: boolean, hasRules = false): string {
  const lines = [
    `# ${title}`,
    '',
    'Generated by Vibe-Code Blueprint.',
    '',
    '## Requirements',
    '',
    '- Node.js 22.5 or newer (https://nodejs.org)',
    '',
    '## Run it',
    '',
    '```bash',
    'npm install',
    'npm run dev',
    '```',
    '',
    hasFrontend
      ? `\`npm run dev\` builds the app, starts ${hasBackend ? 'the API and ' : ''}the website, and opens it in your browser (http://localhost:5173). Press Ctrl+C to stop.`
      : '`npm run dev` builds the app and starts the API on http://localhost:3000. Press Ctrl+C to stop.',
    '',
  ];
  if (hasFrontend && hasBackend) {
    lines.push(
      '## One address, ready to host',
      '',
      '```bash',
      'npm run serve',
      '```',
      '',
      'Builds the website into `dist/web` and serves it together with the API on http://localhost:3000 - the',
      'form to deploy to any Node host.',
      '',
    );
  }
  if (hasRules) {
    lines.push(
      '## Check the architecture',
      '',
      '`generated.blueprint` holds this app\'s architecture rules, compiled from its plan (which part may import',
      'which). After you change the code, check that it still keeps them:',
      '',
      '```bash',
      'npx vibe-blueprint . --blueprint=generated.blueprint',
      '```',
      '',
    );
  }
  return lines.join('\n');
}
