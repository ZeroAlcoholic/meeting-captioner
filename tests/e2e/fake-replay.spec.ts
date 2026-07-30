import { expect, test } from '@playwright/test';

test.describe('fake replay caption path', () => {
  test('renders caption board and plays the scripted captions to completion', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Meeting Audio' })).toBeVisible();
    // Fresh idle screen shows the easy-start launcher in place of the empty
    // caption board (the header Demo button below also still starts replay).
    await expect(page.getByTestId('session-launcher')).toBeVisible();

    const startButton = page.getByTestId('start-fake-replay');
    await expect(startButton).toBeEnabled();
    await startButton.click();

    const current = page.getByTestId('caption-current');
    await expect(current).toBeVisible({ timeout: 10_000 });

    await expect(current).toHaveAttribute('data-status', 'final', { timeout: 12_000 });

    await expect(page.getByTestId('caption-target')).toHaveAttribute('data-status', 'final', {
      timeout: 12_000,
    });

    await expect(page.locator('body')).toContainText('歡迎參加會議。', { timeout: 15_000 });
    await expect(page.locator('body')).toContainText('First, the quarterly review.', {
      timeout: 15_000,
    });
  });

  test('Stop button halts replay', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('start-fake-replay').click();

    await expect(page.getByTestId('caption-current')).toBeVisible({ timeout: 10_000 });

    const stopButton = page.getByTestId('stop-fake-replay');
    await stopButton.click();

    await expect(stopButton).toBeDisabled();
  });

  test('settings panel toggle reveals scenario / mode / health sections', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('settings-panel')).toHaveCount(0);

    await page.getByTestId('settings-toggle').click();

    const panel = page.getByTestId('settings-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('scenario-picker')).toBeVisible();
    await expect(page.getByTestId('mode-selector')).toBeVisible();
    await expect(page.getByTestId('health-row')).toBeVisible();
    // The audio-level meter renders only once a session is emitting levels
    // (hasAudioLevel gate) — exercised in the running-session test below, not
    // on this idle screen.

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('settings-panel')).toHaveCount(0);
  });

  test('health row + audio meter reflect fake provider events', async ({ page }) => {
    await page.goto('/');

    // Idle baseline (panel open).
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'idle');
    // Close the panel BEFORE starting: clicking the header Start button counts
    // as an outside-click that dismisses the panel, so we re-open it afterward.
    await page.getByTestId('settings-toggle').click();

    await page.getByTestId('start-fake-replay').click();
    await page.getByTestId('settings-toggle').click();

    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected', {
      timeout: 5_000,
    });
    // online_full mode shows audio / transport / translation (no 'stt' row —
    // that's a hybrid/offline component). Assert the translation row heals too.
    await expect(page.getByTestId('health-translation')).toHaveAttribute(
      'data-state',
      'connected',
      {
        timeout: 8_000,
      },
    );
    // Once levels flow, the meter mounts.
    await expect(page.getByTestId('audio-level-meter')).toBeVisible({ timeout: 5_000 });
  });
});
