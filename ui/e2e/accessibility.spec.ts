import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility pass: every workspace view and the analysis page must have no
 * axe-core violations (landmarks, headings, labels, colour contrast). The API
 * is stubbed to answer 404, so each view is scanned in its empty state.
 */

test.use({ viewport: { width: 1280, height: 800 } });

const VIEWS: readonly (readonly [string, (page: Page) => Promise<void>])[] = [
  ['analysis page', (page) => page.goto('/').then(() => undefined)],
  ['workspace', (page) => page.goto('/workspace.html').then(() => undefined)],
  [
    'workflow tab',
    async (page) => {
      await page.goto('/workspace.html');
      await page.getByRole('tab', { name: 'Workflow' }).click();
    },
  ],
  [
    'page builder tab',
    async (page) => {
      await page.goto('/workspace.html');
      await page.getByRole('tab', { name: 'Page Builder' }).click();
    },
  ],
  [
    'verification tab',
    async (page) => {
      await page.goto('/workspace.html');
      await page.getByRole('tab', { name: /Verif/ }).click();
    },
  ],
];

for (const [name, open] of VIEWS) {
  test(`${name} has no axe violations`, async ({ page }) => {
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 404, json: { error: 'stubbed' } }),
    );
    await open(page);
    await page.waitForLoadState('networkidle');

    const { violations } = await new AxeBuilder({ page }).analyze();

    expect(
      violations.map(
        (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
      ),
    ).toEqual([]);
  });
}
