import { expect, test } from '@playwright/test';

test.describe('fake replay caption path', () => {
  test('renders caption board and plays the scripted captions to completion', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Meeting Audio' })).toBeVisible();
    await expect(page.getByTestId('caption-empty')).toBeVisible();

    const startButton = page.getByTestId('start-fake-replay');
    await expect(startButton).toBeEnabled();
    await startButton.click();

    const current = page.getByTestId('caption-current');
    await expect(current).toBeVisible({ timeout: 10_000 });

    await expect(current).toHaveAttribute('data-status', 'final', { timeout: 12_000 });

    await expect(page.getByTestId('caption-target')).toHaveAttribute(
      'data-status',
      'final',
      { timeout: 12_000 },
    );

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

  test('settings panel toggle reveals scenario / mode / health / audio level', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('settings-panel')).toHaveCount(0);

    await page.getByTestId('settings-toggle').click();

    const panel = page.getByTestId('settings-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('scenario-picker')).toBeVisible();
    await expect(page.getByTestId('mode-selector')).toBeVisible();
    await expect(page.getByTestId('health-row')).toBeVisible();
    await expect(page.getByTestId('audio-level-meter')).toBeVisible();

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('settings-panel')).toHaveCount(0);
  });

  test('health row reflects fake provider events', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('settings-toggle').click();

    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'idle');

    await page.getByTestId('start-fake-replay').click();

    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected', {
      timeout: 5_000,
    });
    await expect(page.getByTestId('health-stt')).toHaveAttribute('data-state', 'connected', {
      timeout: 8_000,
    });
  });
});
