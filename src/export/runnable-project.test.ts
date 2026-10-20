import { describe, expect, it } from 'vitest';
import { withRunScaffold, type ZipEntry } from './runnable-project.js';

const manifest = JSON.stringify({ name: 'generated-backend', scripts: { build: 'tsc', start: 'node dist/backend/src/index.js' }, devDependencies: { typescript: '^5.5.4' } });
const fullStack: readonly ZipEntry[] = [
  { path: 'package.json', contents: manifest },
  { path: 'backend/src/index.ts', contents: '' },
  { path: 'frontend/src/main.tsx', contents: '' },
];

const byPath = (entries: readonly ZipEntry[]): Map<string, string> => new Map(entries.map((e) => [e.path, e.contents]));

describe('withRunScaffold', () => {
  it('adds an index.html with the root main.tsx mounts into, and a Vite config', () => {
    const files = byPath(withRunScaffold(fullStack, 'Shop <Demo>'));
    expect(files.get('frontend/index.html')).toContain('<div id="root"></div>');
    expect(files.get('frontend/index.html')).toContain('src="/src/main.tsx"');
    expect(files.get('frontend/index.html')).toContain('<title>Shop &lt;Demo&gt;</title>');
    expect(files.get('vite.config.mjs')).toContain("root: 'frontend'");
    expect(files.get('vite.config.mjs')).toContain("'/api': 'http://localhost:3000'");
  });

  it('adds web scripts and Vite dependencies without touching the build', () => {
    const pkg = JSON.parse(byPath(withRunScaffold(fullStack)).get('package.json') ?? '{}') as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts).toMatchObject({
      build: 'tsc',
      start: 'node dist/backend/src/index.js',
      web: 'vite',
      'web:build': 'vite build',
      dev: 'node dev.mjs',
      serve: 'npm run build && npm run web:build && npm start',
    });
    expect(pkg.devDependencies).toHaveProperty('vite');
    expect(pkg.devDependencies).toHaveProperty('@vitejs/plugin-react');
    expect(pkg.devDependencies['typescript']).toBe('^5.5.4');
  });

  it('writes a README a person can follow: install, one command, and the one-port host option', () => {
    const readme = byPath(withRunScaffold(fullStack)).get('README.md') ?? '';
    expect(readme).toContain('npm install\nnpm run dev');
    expect(readme).toContain('opens it in your browser (http://localhost:5173)');
    expect(readme).toContain('npm run serve');
  });

  it('adds dev.mjs: build once, then the API and the site together, the browser opened', () => {
    const dev = byPath(withRunScaffold(fullStack)).get('dev.mjs') ?? '';
    expect(dev).toContain("spawnSync(node, ['node_modules/typescript/bin/tsc']");
    expect(dev).toContain("spawn(node, ['dist/backend/src/index.js']");
    expect(dev).toContain("spawn(node, ['node_modules/vite/bin/vite.js', '--open']");
  });

  it('adds no frontend scaffolding to a backend-only project', () => {
    const files = byPath(withRunScaffold(fullStack.filter((e) => e.path !== 'frontend/src/main.tsx')));
    expect(files.has('frontend/index.html')).toBe(false);
    expect(files.has('vite.config.mjs')).toBe(false);
    const pkg = JSON.parse(files.get('package.json') ?? '{}') as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts).toEqual({ build: 'tsc', start: 'node dist/backend/src/index.js', dev: 'node dev.mjs' });
    expect(pkg.devDependencies).not.toHaveProperty('vite');
    expect(files.get('README.md')).toContain('starts the API on http://localhost:3000');
    expect(files.get('README.md')).not.toContain('npm run serve');
  });

  it('never overwrites a file the project already has', () => {
    const own = [...fullStack, { path: 'frontend/index.html', contents: 'mine' }];
    expect(byPath(withRunScaffold(own)).get('frontend/index.html')).toBe('mine');
  });
});
