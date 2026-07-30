import { expect, test } from '@playwright/test';

test.describe('scenario switching', () => {
  test('running locks scenario; Stop unlocks it without clearing caption history', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('settings-toggle').click();

    await expect(page.getByTestId('scenario-physical')).toBeChecked();

    // Starting from the header dismisses the panel (outside-click) — re-open it
    // before touching in-panel controls again.
    await page.getByTestId('start-fake-replay').click();

    await expect(page.locator('body')).toContainText('歡迎參加會議。', { timeout: 15_000 });

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('scenario-hybrid')).toBeDisabled();
    await expect(page.getByTestId('scenario-physical')).toBeChecked();

    await page.getByTestId('stop-fake-replay').click();
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('scenario-hybrid')).toBeEnabled();
    await page.getByTestId('scenario-hybrid').check();
    await expect(page.getByTestId('scenario-hybrid')).toBeChecked();

    await expect(page.locator('body')).toContainText('歡迎參加會議。');
  });

  test('Advanced Manual scenario is disabled in P1', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('settings-toggle').click();

    const advanced = page.getByTestId('scenario-advanced');
    await expect(advanced).toBeDisabled();
  });
});
