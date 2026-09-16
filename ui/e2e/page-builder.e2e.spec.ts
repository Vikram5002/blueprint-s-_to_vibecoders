import { test, expect, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

/**
 * Milestone 1 of the page builder: real drag-and-drop
 * (@dnd-kit/core) places real elements on the fixed 1280x800 canvas, one
 * color is set from the fixed token palette, and "Generate" produces one
 * real `.tsx` file via the deterministic `layoutToComponentFile`
 * (src/generate/canvas-layout.ts) - no LLM call anywhere in this path.
 *
 * This test does not stop at reading the generated code back out of the
 * UI - per the explicit verification requirement, it writes that exact
 * generated file into a real, separately-scaffolded React+Vite project,
 * runs a real `npm install` and a real `tsc` build against it, then starts
 * a real Vite dev server and navigates a SECOND page to it, asserting the
 * actual rendered DOM's position and color against the values placed in
 * the builder - not trusting that "the code looks plausible" is the same
 * as "the code renders correctly."
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CLI_PATH = resolve(REPO_ROOT, 'dist/cli.js');
const FIXTURE_PATH = resolve(REPO_ROOT, 'src/graph/fixtures/ts-monorepo');

interface RunningCli {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

async function startCli(): Promise<RunningCli> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI_PATH, FIXTURE_PATH, '--no-open'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });

  const baseUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      rejectUrl(new Error(`CLI did not print a server URL within 45s.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 45_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolveUrl(match[0]);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      rejectUrl(new Error(`CLI exited early with code ${code} before printing a server URL.\nstderr: ${stderr}`));
    });
  });

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolveStop) => {
        child.once('exit', () => resolveStop());
        child.kill();
      }),
  };
}

/**
 * Manual pointer sequence, not `locator.dragTo()` - @dnd-kit's PointerSensor
 * needs real intermediate mousemove events to register a drag start, which
 * a single synthetic drag-and-drop DOM event does not produce. The small
 * waits between steps mimic a real human drag's timing (a real drag takes
 * hundreds of milliseconds, not zero) rather than firing every pointer
 * event back-to-back in the same tick.
 */
async function dragTo(
  page: Page,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(50);
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, {
      steps: 1,
    });
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(50);
  await page.mouse.up();
}

function runCommand(command: string, args: readonly string[], cwd: string): Promise<{ readonly ok: boolean; readonly output: string }> {
  return new Promise((resolveRun) => {
    let output = '';
    const child = spawn(command, args, { cwd, shell: true });
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolveRun({ ok: code === 0, output }));
    child.on('error', (cause) => resolveRun({ ok: false, output: String(cause) }));
  });
}

/** A real, currently-free TCP port - bind to port 0, read back whatever the OS assigned, release it immediately. There is a real, unavoidable gap between releasing it here and Vite binding it a moment later, but it is far narrower than the fragile alternative of parsing a free port out of a CLI's own retry-scan banner text. */
async function getFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => {
        if (port === null) {
          rejectPort(new Error('could not determine a free port'));
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

/** Polls the real HTTP endpoint until it answers - not a fixed sleep, and not a parse of the server's own startup log text. */
async function waitForServer(url: string, timeoutMs: number, describeOutput: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // Not up yet - fall through to the deadline check and retry.
    }
    if (Date.now() > deadline) {
      throw new Error(`server at ${url} did not respond within ${timeoutMs}ms.\n${describeOutput()}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}

test.describe('Page builder Milestone 1: real drag-and-drop, real deterministic generation, real render', () => {
  test.setTimeout(300_000);
  // Large enough that the full 1280px canvas PLUS the palette sidebar and
  // the 260px inspector column all fit side by side without horizontal
  // scroll - page.mouse actions operate at raw viewport coordinates and do
  // not auto-scroll the way locator.click() does, so a drop target below
  // the fold (or a swatch off to the right) would silently miss, or worse,
  // a `.click()`-triggered auto-scroll into view would shift every other
  // element's own viewport-relative coordinates out from under an
  // in-flight boundingBox() comparison - found live, where clicking an
  // off-screen color swatch scrolled the page and made an untouched,
  // correctly-positioned button look like it had jumped.
  test.use({ viewport: { width: 2400, height: 1400 } });

  let cli: RunningCli;

  test.beforeAll(async () => {
    cli = await startCli();
  }, 60_000);

  test.afterAll(async () => {
    await cli?.stop();
  });

  test('places a button and text via real drag-and-drop, generates a real file, and the generated file actually builds and renders correctly', async ({
    page,
  }) => {
    await page.goto(`${cli.baseUrl}/workspace.html`);
    await page.getByRole('tab', { name: 'Page builder' }).click();

    const canvas = page.getByTestId('page-builder-canvas');
    await expect(canvas).toBeVisible();
    const canvasBox = await canvas.boundingBox();
    if (canvasBox === null) throw new Error('canvas has no bounding box');

    // Real drag 1: the button palette item, onto a specific canvas position.
    //
    // The app computes a dropped element's position from the DRAGGED
    // ITEM's own final rect (`event.active.rect.current.translated`), not
    // from wherever the mouse pointer itself ends up - dnd-kit moves the
    // dragged node by the raw pointer delta, so the node's final top-left
    // is `initialTopLeft + (pointerEnd - pointerStart)`. Grabbing from the
    // item's CENTER (as an earlier version of this test did) means that
    // offset does not cancel out, since the palette item's own size
    // (134x34) differs from the placed element's default size (160x40) -
    // found live as a real off-by-half-width test bug, not an app bug.
    // Grabbing near the top-left corner instead, and compensating the
    // pointer target by that exact same inset, makes the dragged item's
    // own final top-left land exactly on the intended canvas coordinate,
    // regardless of the palette item's own dimensions.
    const GRAB_INSET = 5;
    const buttonPalette = page.getByTestId('palette-button');
    const buttonPaletteBox = await buttonPalette.boundingBox();
    if (buttonPaletteBox === null) throw new Error('button palette item has no bounding box');
    await dragTo(
      page,
      { x: buttonPaletteBox.x + GRAB_INSET, y: buttonPaletteBox.y + GRAB_INSET },
      { x: canvasBox.x + 200 + GRAB_INSET, y: canvasBox.y + 100 + GRAB_INSET },
    );

    const placedButtons = page.locator('[data-testid^="placed-"]');
    await expect(placedButtons).toHaveCount(1);

    // Real drag 2: the text palette item, onto a different canvas position.
    const textPalette = page.getByTestId('palette-text');
    const textPaletteBox = await textPalette.boundingBox();
    if (textPaletteBox === null) throw new Error('text palette item has no bounding box');
    await dragTo(
      page,
      { x: textPaletteBox.x + GRAB_INSET, y: textPaletteBox.y + GRAB_INSET },
      { x: canvasBox.x + 200 + GRAB_INSET, y: canvasBox.y + 300 + GRAB_INSET },
    );

    await expect(placedButtons).toHaveCount(2);

    // Select the button (the first placed element) and set its color from
    // the fixed token palette - a real click on a real swatch, not a
    // programmatic state mutation.
    const buttonElement = placedButtons.first();
    await buttonElement.click();
    await page.getByTestId('color-danger').click();

    await page.getByRole('button', { name: 'Generate' }).click();

    const generatedCode = page.getByTestId('generated-code');
    await expect(generatedCode).toBeVisible();
    const contents = (await generatedCode.textContent()) ?? '';

    expect(contents).toContain("export const LandingPage: FC = () => {");
    expect(contents).toContain('#dc2626'); // the real 'danger' token hex
    expect(contents).toContain('Click me');
    expect(contents).toContain('Text label');

    // --- Independent verification: real scaffold, real npm install, real
    // tsc build, real Vite render - not trusting the UI's own claim that
    // this is valid, renderable code.
    const scaffoldRoot = await mkdtemp(join(tmpdir(), 'vibe-page-builder-scaffold-'));
    let devServer: ChildProcessWithoutNullStreams | null = null;
    try {
      const pagePath = join(scaffoldRoot, 'frontend', 'src', 'pages', 'landing-page.tsx');
      await mkdir(join(pagePath, '..'), { recursive: true });
      await writeFile(pagePath, contents, 'utf8');

      await writeFile(
        join(scaffoldRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'page-builder-verification-scaffold',
            private: true,
            type: 'module',
            version: '0.0.0',
            scripts: { build: 'tsc --noEmit', dev: 'vite' },
            dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
            devDependencies: {
              '@types/react': '^18.3.12',
              '@types/react-dom': '^18.3.1',
              '@vitejs/plugin-react': '^4.3.3',
              typescript: '^5.6.3',
              vite: '^5.4.11',
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      await writeFile(
        join(scaffoldRoot, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2020',
              module: 'ESNext',
              moduleResolution: 'bundler',
              jsx: 'react-jsx',
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ['frontend/**/*.tsx', 'src/**/*.tsx'],
          },
          null,
          2,
        ),
        'utf8',
      );

      await writeFile(
        join(scaffoldRoot, 'vite.config.ts'),
        "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
        'utf8',
      );

      await mkdir(join(scaffoldRoot, 'src'), { recursive: true });
      await writeFile(
        join(scaffoldRoot, 'index.html'),
        // Zeroed body margin: a default browser 8px body margin would
        // otherwise shift every absolute-positioned element's rendered
        // bounding box away from its real, generated coordinate, which
        // would make an exact pixel assertion fail for a reason that has
        // nothing to do with whether the generated code is correct.
        '<!doctype html><html><head><style>body{margin:0}</style></head>' +
          '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
        'utf8',
      );
      await writeFile(
        join(scaffoldRoot, 'src', 'main.tsx'),
        "import { StrictMode } from 'react';\n" +
          "import { createRoot } from 'react-dom/client';\n" +
          "import { LandingPage } from '../frontend/src/pages/landing-page';\n" +
          "const container = document.getElementById('root')!;\n" +
          'createRoot(container).render(<StrictMode><LandingPage /></StrictMode>);\n',
        'utf8',
      );

      const install = await runCommand('npm', ['install', '--no-audit', '--no-fund'], scaffoldRoot);
      expect(install.ok, `npm install failed:\n${install.output}`).toBe(true);

      // Node directly against each package's own JS entry point, never a
      // `.cmd`/`.bin` shim through `shell: true` - on Windows, killing a
      // shell-wrapped process only kills the `cmd.exe` wrapper, not the
      // real Node process running underneath it, which is exactly what
      // left the Vite dev server (and its file watchers) alive and holding
      // the scaffold directory's files locked well after `devServer.kill()`
      // returned, found live via a real EBUSY cleanup failure.
      const tscBin = require.resolve('typescript/bin/tsc', { paths: [scaffoldRoot] });
      expect(() => execFileSync(process.execPath, [tscBin, '--noEmit'], { cwd: scaffoldRoot, stdio: 'pipe' })).not.toThrow();

      // Real Vite dev server, real second page, real render.
      // Built directly, not require.resolve('vite/bin/vite.js') - vite's
      // own package.json restricts subpath resolution via its "exports"
      // map, which does not list bin/vite.js as an importable subpath even
      // though the file is really there on disk (confirmed directly:
      // node_modules/vite/bin/vite.js exists in every vite install this
      // project's own package.json version range produces).
      const viteBin = join(scaffoldRoot, 'node_modules', 'vite', 'bin', 'vite.js');
      // A genuinely free port, picked before spawning - not parsed out of
      // Vite's own terminal banner afterward. Parsing stdout/stderr for
      // "Local: http://localhost:<port>" proved unreliable here (the text
      // was visibly present in the captured output yet the regex never
      // matched in time, live, across several real runs - plausibly an
      // ANSI/cursor-control interaction this project has no need to chase
      // down further) and is strictly more fragile than deciding the port
      // ourselves and asserting the server actually answers on it.
      const devPort = await getFreePort();
      const devUrl = `http://localhost:${devPort}`;
      devServer = spawn(process.execPath, [viteBin, '--port', String(devPort), '--strictPort'], {
        cwd: scaffoldRoot,
        stdio: 'pipe',
      });
      let devServerOutput = '';
      devServer.stdout.on('data', (chunk: Buffer) => (devServerOutput += chunk.toString()));
      devServer.stderr.on('data', (chunk: Buffer) => (devServerOutput += chunk.toString()));
      await waitForServer(devUrl, 30_000, () => devServerOutput);

      const renderPage = await page.context().newPage();
      await renderPage.goto(devUrl);

      const renderedButton = renderPage.getByText('Click me');
      const renderedText = renderPage.getByText('Text label');
      await expect(renderedButton).toBeVisible();
      await expect(renderedText).toBeVisible();

      // Exact position, matching what was placed in the builder to the
      // pixel - not "approximately in the right area."
      const buttonRenderedBox = await renderedButton.boundingBox();
      const textRenderedBox = await renderedText.boundingBox();
      if (buttonRenderedBox === null || textRenderedBox === null) {
        throw new Error('rendered elements have no bounding box');
      }
      expect(Math.round(buttonRenderedBox.x)).toBe(200);
      expect(Math.round(buttonRenderedBox.y)).toBe(100);
      expect(Math.round(textRenderedBox.x)).toBe(200);
      expect(Math.round(textRenderedBox.y)).toBe(300);

      // Exact color, matching the real DESIGN_TOKENS.danger hex.
      const buttonColor = await renderedButton.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(buttonColor).toBe('rgb(220, 38, 38)'); // #dc2626

      await renderPage.screenshot({ path: 'test-results/page-builder-rendered.png', fullPage: false });

      await renderPage.close();
    } finally {
      devServer?.kill();
      // A just-killed Vite dev server (esbuild's file watchers in
      // particular) can hold Windows file handles open for a short moment
      // after the process signal is sent - retry the cleanup rather than
      // fail the whole test over a directory removal timing race that has
      // nothing to do with what this test actually verifies.
      await rm(scaffoldRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
});

/**
 * Regression coverage for two bugs that made the Inspector's controls
 * effectively unreachable, both reported by a real user as "there is no
 * colour option and no way to name a button" - the controls existed and had
 * existed all along, but:
 *
 *  1. The 1280px canvas WAS the `1fr` grid item, and a grid item with a
 *     definite width contributes that width as the track's minimum, so the
 *     track resolved to a literal 1280px and shoved the 260px Inspector
 *     column off the right edge (measured at x=1784 in a 1536px window,
 *     with no page scrollbar to reach it).
 *  2. Clicking a placed element selected it on pointerup and then instantly
 *     cleared it, because the click bubbled to the canvas's own
 *     clear-selection handler - so an element was only ever editable in the
 *     instant after being dropped.
 *
 * Deliberately runs at a REALISTIC 1536x730 viewport, not the 2400x1400 the
 * suite above uses: that large viewport is exactly why neither bug was ever
 * caught, since at 2400px wide everything fit regardless.
 */
test.describe('Page builder: the Inspector is reachable and usable at a real window size', () => {
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1536, height: 730 } });

  let cli: RunningCli;

  test.beforeAll(async () => {
    cli = await startCli();
  }, 60_000);

  test.afterAll(async () => {
    await cli?.stop();
  });

  test('renames, recolours, animates and deletes an element - all of it on screen', async ({ page }) => {
    await page.goto(`${cli.baseUrl}/workspace.html`);
    await page.getByRole('tab', { name: 'Page builder' }).click();

    const canvasBox = await page.getByTestId('page-builder-canvas').boundingBox();
    const paletteBox = await page.getByTestId('palette-button').boundingBox();
    if (canvasBox === null || paletteBox === null) throw new Error('missing bounding box');

    const GRAB_INSET = 5;
    await dragTo(
      page,
      { x: paletteBox.x + GRAB_INSET, y: paletteBox.y + GRAB_INSET },
      { x: canvasBox.x + 120 + GRAB_INSET, y: canvasBox.y + 120 + GRAB_INSET },
    );

    // Bug 1: the whole Inspector must be inside the window, not past its edge.
    const inspectorOnScreen = await page.evaluate(() => {
      const heading = [...document.querySelectorAll('h4')].find((el) => el.textContent?.trim() === 'Inspector');
      const panel = heading?.closest('aside');
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewportWidth: window.innerWidth };
    });
    if (inspectorOnScreen === null) throw new Error('Inspector panel not found');
    expect(inspectorOnScreen.left).toBeGreaterThanOrEqual(0);
    expect(inspectorOnScreen.right).toBeLessThanOrEqual(inspectorOnScreen.viewportWidth);

    // A drop auto-selects, so clear that first: clicking the empty canvas
    // BACKGROUND must still deselect (the other half of the fix).
    const inspector = page.locator('aside').last();
    const labelInput = inspector.locator('input[type="text"]');
    await expect(labelInput).toBeVisible();
    await page.mouse.click(canvasBox.x + 500, canvasBox.y + 350);
    await expect(labelInput).toHaveCount(0);

    // Bug 2: click the placed element - it must become, and STAY, selected.
    const placed = page.locator('[data-testid^="placed-"]').first();
    const placedBox = await placed.boundingBox();
    if (placedBox === null) throw new Error('placed element has no bounding box');
    await page.mouse.click(placedBox.x + placedBox.width / 2, placedBox.y + placedBox.height / 2);
    await expect(labelInput).toBeVisible();

    // Now actually use the controls the user said did not exist.
    await labelInput.fill('Submit');
    await page.getByTestId('color-success').click();
    await page.getByTestId('animation-select').selectOption('slide-up');

    await expect(placed).toHaveText('Submit');
    await expect
      .poll(async () => placed.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(22, 163, 74)'); // DESIGN_TOKENS.success, #16a34a

    // All three choices must survive into the real generated file.
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    const code = page.getByTestId('generated-code');
    await expect(code).toBeVisible();
    await expect(code).toContainText('>Submit</button>');
    await expect(code).toContainText('@keyframes vb-slide-up');
    await expect(code).toContainText("animation: 'vb-slide-up");

    // Delete removes it for real.
    await page.mouse.click(placedBox.x + placedBox.width / 2, placedBox.y + placedBox.height / 2);
    await page.getByTestId('delete-element').click();
    await expect(page.locator('[data-testid^="placed-"]')).toHaveCount(0);
  });
});
