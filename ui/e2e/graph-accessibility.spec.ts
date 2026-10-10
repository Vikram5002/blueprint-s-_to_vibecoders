import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // The graph UI needs an analyzed repository. Keep this browser check
  // deterministic and scoped to the accessible empty/error state.
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: { error: 'No analysis fixture' } }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Vibe-Code Blueprint' })).toBeVisible();
});

test('empty analysis view has no WCAG A/AA axe violations', async ({ page }) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(
    violations.map(
      (violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(' ')).join(', ')})`,
    ),
  ).toEqual([]);
});

test('skip link and graph grouping controls work from the keyboard', async ({ page }) => {
  const skipLink = page.getByRole('link', { name: 'Skip to architecture graph' });
  const folders = page.getByRole('button', { name: 'Folders' });
  const modules = page.getByRole('button', { name: 'Modules' });

  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');

  await page.keyboard.press('Tab');
  await expect(folders).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(modules).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(modules).toHaveAttribute('aria-pressed', 'true');
  await expect(folders).toHaveAttribute('aria-pressed', 'false');
});
