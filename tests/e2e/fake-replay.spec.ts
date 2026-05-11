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
});
