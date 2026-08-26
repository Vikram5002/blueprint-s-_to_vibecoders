import { test, expect } from '@playwright/test';

/**
 * Covers ui/src/workspace/: WorkspaceShell, Sidebar, ConversationPane,
 * PromptBar, store.ts. No backend — the shell is placeholder content only
 * (see each component's own doc comment), so these tests assert the real
 * current behavior, not an intended future one.
 */

test.describe('workspace shell — 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('renders sidebar at 240px, conversation pane, and prompt bar with zero console errors', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/workspace.html');

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible();
    const sidebarWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
    expect(sidebarWidth).toBe(240);

    await expect(page.getByText('No messages yet. The conversation will appear here.')).toBeVisible();
    await expect(page.getByPlaceholder('Message...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});

test.describe('workspace shell — 768px', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('renders the same three regions with zero horizontal overflow', async ({ page }) => {
    await page.goto('/workspace.html');

    await expect(page.locator('aside')).toBeVisible();
    await expect(page.getByText('No messages yet. The conversation will appear here.')).toBeVisible();
    await expect(page.getByPlaceholder('Message...')).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBe(innerWidth);
  });
});

test.describe('sidebar collapse / expand', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('collapses to 56px and updates the toggle label, then expands back to 240px', async ({
    page,
  }) => {
    await page.goto('/workspace.html');

    const sidebar = page.locator('aside');
    const toggle = page.getByRole('button', { name: 'Collapse sidebar' });

    await expect(sidebar).toHaveJSProperty('offsetWidth', 240);
    await expect(toggle).toBeVisible();

    await toggle.click();

    const collapsedToggle = page.getByRole('button', { name: 'Expand sidebar' });
    await expect(collapsedToggle).toBeVisible();
    await expect
      .poll(() => sidebar.evaluate((el) => el.getBoundingClientRect().width))
      .toBe(56);

    await collapsedToggle.click();

    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await expect
      .poll(() => sidebar.evaluate((el) => el.getBoundingClientRect().width))
      .toBe(240);
  });
});

test.describe('prompt bar', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('typing updates the textarea value; submit stays disabled regardless of input', async ({
    page,
  }) => {
    await page.goto('/workspace.html');

    const textarea = page.getByPlaceholder('Message...');
    const submit = page.getByRole('button', { name: 'Send' });

    // Current store.ts has no field tied to prompt text, and PromptBar.tsx
    // hardcodes `disabled` on the submit button — it is never re-enabled.
    // This is documented as intentional in PromptBar.tsx ("Deliberately
    // disabled... not yet wired to anything"), not a bug, so this test
    // asserts that actual behavior rather than an enabled-when-non-empty
    // rule the code does not implement.
    await expect(submit).toBeDisabled();

    await textarea.fill('hello world');
    await expect(textarea).toHaveValue('hello world');
    await expect(submit).toBeDisabled();

    await textarea.fill('');
    await expect(textarea).toHaveValue('');
    await expect(submit).toBeDisabled();
  });
});
