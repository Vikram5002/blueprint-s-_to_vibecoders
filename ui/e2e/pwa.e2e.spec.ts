import { test, expect } from '@playwright/test';
import { startCli, type RunningCli } from './cli-server';

/**
 * The installable app (PWA), against the real built server: the manifest and
 * icons it points at are served with the right types, the service worker
 * takes control, and an installed app opened while the server is down gets
 * the "not running" page instead of a browser error.
 */

let cli: RunningCli;

test.beforeAll(async () => {
  cli = await startCli();
});

test.afterAll(async () => {
  await cli?.stop();
});

test('the manifest, its icons and the service worker are served correctly', async ({ request }) => {
  const manifest = await request.get(`${cli.baseUrl}/manifest.webmanifest`);
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  const body = (await manifest.json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string }[];
  };
  expect(body).toMatchObject({
    name: 'VibeCoder',
    start_url: '/workspace.html',
    display: 'standalone',
  });
  for (const icon of body.icons) {
    const response = await request.get(`${cli.baseUrl}${icon.src}`);
    expect(response.status(), icon.src).toBe(200);
    expect(response.headers()['content-type']).toBe('image/png');
  }
  expect((await request.get(`${cli.baseUrl}/icons/no-such-icon.png`)).status()).toBe(404);
  const sw = await request.get(`${cli.baseUrl}/sw.js`);
  expect(sw.headers()['content-type']).toContain('javascript');
});

test('both pages link the manifest, and the service worker takes control', async ({ page }) => {
  for (const path of ['/workspace.html', '/']) {
    await page.goto(`${cli.baseUrl}${path}`);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    );
  }
  await page.goto(`${cli.baseUrl}/workspace.html`);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(`${cli.baseUrl}/`);
});

test('with the server unreachable, a page load shows how to start it', async ({
  page,
  context,
}) => {
  await page.goto(`${cli.baseUrl}/workspace.html`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // now controlled by the service worker
  await context.setOffline(true);
  await page.goto(`${cli.baseUrl}/workspace.html`);
  await expect(page.getByRole('heading', { name: 'VibeCoder is not running' })).toBeVisible();
  await expect(page.locator('#port')).toHaveText(new URL(cli.baseUrl).port);
  await context.setOffline(false);
});
