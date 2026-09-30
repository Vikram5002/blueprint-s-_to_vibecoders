import { test, expect } from '@playwright/test';

/**
 * The Page Builder's designer agent, with /api/page-builder/design stubbed:
 * a request lands on the canvas as one undo step, and the person's own edits
 * made while it thinks are kept. Operation checking itself is unit-tested
 * (src/generate/page-designer.test.ts, ui/src/workspace/page-designer.test.ts).
 */

test.use({ viewport: { width: 1440, height: 900 } });

test('a request edits the canvas, reports the change, and one undo takes it back', async ({ page }) => {
  let sentElements = -1;
  await page.route('**/api/page-builder/design', async (route) => {
    sentElements = (route.request().postDataJSON() as { layout: { elements: unknown[] } }).layout.elements.length;
    await route.fulfill({
      json: {
        reply: 'Added a welcome heading.',
        operations: [{ op: 'add', type: 'heading', x: 80, y: 80, width: 520, height: 64, label: 'Welcome to Campus Fest', colorToken: 'dark' }],
        refused: 0,
      },
    });
  });
  await page.goto('/workspace.html');
  await page.getByRole('tab', { name: 'Page builder' }).click();
  const placed = page.locator('[data-testid^="placed-"]');
  await expect(placed).toHaveCount(0);

  await page.getByTestId('designer-open').click();
  await page.getByTestId('designer-input').fill('add a welcome heading');
  await page.getByTestId('designer-send').click();

  await expect(page.getByTestId('designer-reply')).toContainText('Added a welcome heading.');
  await expect(page.getByTestId('designer-reply')).toContainText('1 change on the page');
  await expect(placed).toHaveCount(1);
  await expect(page.getByTestId('page-builder-canvas')).toContainText('Welcome to Campus Fest');
  expect(sentElements).toBe(0);

  // One undo step takes back exactly what the designer did.
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(placed).toHaveCount(0);
});

test('the person keeps working while the designer thinks, and both changes survive', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/page-builder/design', async (route) => {
    await held;
    await route.fulfill({
      json: { reply: 'Added a footer.', operations: [{ op: 'add', type: 'footer', x: 0, y: 700, width: 1280, height: 100, label: 'Campus Fest 2026', colorToken: 'dark' }], refused: 0 },
    });
  });
  await page.goto('/workspace.html');
  await page.getByRole('tab', { name: 'Page builder' }).click();
  await page.getByTestId('designer-open').click();
  await page.getByTestId('designer-input').fill('add a footer');
  await page.getByTestId('designer-send').click();

  // While the designer is still thinking, the person adds a whole section by hand.
  await page.getByTestId('add-template').selectOption('split-panel');
  const placed = page.locator('[data-testid^="placed-"]');
  await expect(placed).toHaveCount(7);

  release();
  await expect(page.getByTestId('designer-reply')).toContainText('Added a footer.');
  await expect(placed).toHaveCount(8);
});
