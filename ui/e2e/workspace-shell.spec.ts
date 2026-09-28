import { test, expect } from '@playwright/test';

/**
 * Covers ui/src/workspace/: WorkspaceShell, Sidebar, ConversationPane (Agent
 * mode) and store.ts. No backend: these check the shell itself - layout,
 * tabs, the agent's input - not a run (agent-runner.test.ts covers the
 * agent's decisions).
 *
 * Sidebar is the one exception: it now fetches `/api/workflow/sessions` on
 * mount (a real workspace-sessions-store.ts feature, tested against a real
 * backend in workflow-sessions.e2e.spec.ts). This config's `npm run dev`
 * webServer has no backend behind it at all (vite.config.ts's own proxy
 * comment notwithstanding — there is nothing running on the port it points
 * at here), so that fetch genuinely 500s, and Chromium logs the failed
 * resource load as a console error regardless of Sidebar's own try/catch —
 * that part is a real HTTP response, not something app code controls. React
 * 18 StrictMode mounts Sidebar twice, so this shows up as exactly two
 * matching console errors. `EXPECTED_SESSIONS_FETCH_NOISE` filters out only
 * that one known, harmless message so these tests still catch a real
 * regression anywhere else in the page.
 */
const EXPECTED_SESSIONS_FETCH_NOISE = 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)';

test.describe('workspace shell — 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('renders sidebar at 240px and the Agent mode pane with zero console errors', async ({
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

    await expect(page.getByText('Agent mode')).toBeVisible();
    await expect(page.getByTestId('agent-prompt')).toBeVisible();
    await expect(page.getByTestId('agent-start')).toBeVisible();

    expect(consoleErrors.filter((message) => message !== EXPECTED_SESSIONS_FETCH_NOISE)).toEqual([]);
  });
});

test.describe('workspace shell — 768px', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('renders the same three regions with zero horizontal overflow', async ({ page }) => {
    await page.goto('/workspace.html');

    await expect(page.locator('aside')).toBeVisible();
    await expect(page.getByText('Agent mode')).toBeVisible();
    await expect(page.getByTestId('agent-prompt')).toBeVisible();

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
    const pageBuilderTab = page.getByRole('tab', { name: 'Page builder' });
    const verificationTab = page.getByRole('tab', { name: 'Verification (mock)' });
    const workflowTab = page.getByRole('tab', { name: 'Workflow graph (mock)' });

    await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Agent mode')).toBeVisible();

    await pageBuilderTab.click();
    await expect(pageBuilderTab).toHaveAttribute('aria-selected', 'true');
    await expect(conversationTab).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('page-builder-canvas')).toBeVisible();

    await verificationTab.click();
    await expect(verificationTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('No backend exists yet. Every scenario below')).toBeVisible();

    await workflowTab.click();
    await expect(workflowTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Small project' })).toBeVisible();

    await conversationTab.click();
    await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('agent-prompt')).toBeVisible();

    expect(consoleErrors.filter((message) => message !== EXPECTED_SESSIONS_FETCH_NOISE)).toEqual([]);
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

  for (const tab of ['Conversation', 'Page builder', 'Verification (mock)', 'Workflow graph (mock)']) {
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

test.describe('agent input', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Build it is disabled until something is typed, and disabled again when cleared', async ({ page }) => {
    await page.goto('/workspace.html');

    const prompt = page.getByTestId('agent-prompt');
    const start = page.getByTestId('agent-start');

    await expect(start).toBeDisabled();
    await prompt.fill('A booking site for a yoga studio');
    await expect(prompt).toHaveValue('A booking site for a yoga studio');
    await expect(start).toBeEnabled();
    await prompt.fill('   ');
    await expect(start).toBeDisabled();
  });
});

test.describe('page templates (formerly the Page regions tab)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the single-column and split-panel layouts are Page Builder templates now', async ({ page }) => {
    await page.goto('/workspace.html');
    await expect(page.getByRole('tab', { name: /Page regions/ })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Page builder' }).click();

    await page.getByTestId('add-template').selectOption('split-panel');
    await expect(page.locator('[data-testid^="placed-"]')).toHaveCount(7);
  });
});
