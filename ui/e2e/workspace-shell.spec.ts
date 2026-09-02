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

test.describe('tab navigation', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('starts on Conversation and moves between all four sections with zero console errors', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/workspace.html');

    const conversationTab = page.getByRole('tab', { name: 'Conversation' });
    const layoutTab = page.getByRole('tab', { name: 'Layout (mock)' });
    const verificationTab = page.getByRole('tab', { name: 'Verification (mock)' });
    const workflowTab = page.getByRole('tab', { name: 'Workflow graph (mock)' });

    await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('No messages yet. The conversation will appear here.')).toBeVisible();

    await layoutTab.click();
    await expect(layoutTab).toHaveAttribute('aria-selected', 'true');
    await expect(conversationTab).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByText('Mock data — these presets are hard-coded')).toBeVisible();

    await verificationTab.click();
    await expect(verificationTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('No backend exists yet. Every scenario below')).toBeVisible();

    await workflowTab.click();
    await expect(workflowTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Small project' })).toBeVisible();

    await conversationTab.click();
    await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByPlaceholder('Message...')).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});

test.describe('verification display — three outcomes', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('each scenario renders its own visually distinct, unambiguous outcome', async ({ page }) => {
    await page.goto('/workspace.html');
    await page.getByRole('tab', { name: 'Verification (mock)' }).click();

    await page.getByRole('button', { name: 'Verified' }).click();
    await expect(page.locator('[data-outcome="verified"]')).toBeVisible();
    await expect(page.locator('[data-outcome="verified"]').getByText('Verified')).toBeVisible();

    await page.getByRole('button', { name: 'Violation detected' }).click();
    await expect(page.locator('[data-outcome="violated"]')).toBeVisible();
    await expect(page.locator('[data-outcome="violated"]').getByText('Violation Detected')).toBeVisible();

    await page.getByRole('button', { name: 'Unverifiable — no rules stated' }).click();
    await expect(page.locator('[data-outcome="unverifiable"]')).toBeVisible();
    await expect(page.getByText('This code was not verified against anything.')).toBeVisible();

    await page.getByRole('button', { name: 'Unverifiable — rules unresolved' }).click();
    await expect(page.locator('[data-outcome="unverifiable"]')).toBeVisible();

    // Only one outcome renders at a time — never two outcome containers, and
    // never "verified" alongside anything unverifiable.
    await expect(page.locator('[data-outcome]')).toHaveCount(1);
  });
});

test.describe('workflow graph — fit-to-view', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('renders the four domain nodes and responds to the fit-to-view control', async ({ page }) => {
    await page.goto('/workspace.html');
    await page.getByRole('tab', { name: 'Workflow graph (mock)' }).click();

    await expect(page.getByTestId('rf__node-frontend').getByText('Frontend')).toBeVisible();
    await expect(page.getByTestId('rf__node-backend').getByText('Backend')).toBeVisible();
    await expect(page.getByTestId('rf__node-database').getByText('Database')).toBeVisible();
    await expect(page.getByTestId('rf__node-security').getByText('Security')).toBeVisible();

    const viewport = page.locator('.react-flow__viewport');
    const before = await viewport.getAttribute('style');

    await page.locator('.react-flow__controls-zoomin').click();
    await page.locator('.react-flow__controls-zoomin').click();
    const zoomed = await viewport.getAttribute('style');
    expect(zoomed).not.toBe(before);

    await page.locator('.react-flow__controls-fitview').click();
    await expect
      .poll(async () => viewport.getAttribute('style'))
      .not.toBe(zoomed);
  });
});

test.describe('no horizontal overflow at 768px', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  for (const tab of ['Conversation', 'Layout (mock)', 'Verification (mock)', 'Workflow graph (mock)']) {
    test(`"${tab}" tab has no horizontal overflow`, async ({ page }) => {
      await page.goto('/workspace.html');
      await page.getByRole('tab', { name: tab }).click();

      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth).toBe(innerWidth);
    });
  }
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
