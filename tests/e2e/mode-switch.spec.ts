import { expect, test } from '@playwright/test';

test.describe('mode switching', () => {
  test('running locks mode; Stop unlocks it without clearing caption history', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('settings-toggle').click();

    await expect(page.getByTestId('mode-online_full')).toBeChecked();

    // Starting from the header dismisses the panel (outside-click) — re-open it
    // before touching in-panel controls again.
    await page.getByTestId('start-fake-replay').click();

    await expect(page.locator('body')).toContainText('歡迎參加會議。', { timeout: 15_000 });

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('mode-full_offline')).toBeDisabled();
    await expect(page.getByTestId('mode-online_full')).toBeChecked();

    await page.getByTestId('stop-fake-replay').click();
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('mode-full_offline')).toBeEnabled();
    await page.getByTestId('mode-full_offline').check();
    await expect(page.getByTestId('mode-full_offline')).toBeChecked();

    await expect(page.locator('body')).toContainText('歡迎參加會議。');
  });

  test('all three modes are selectable', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('settings-toggle').click();

    for (const id of ['online_full', 'hybrid_privacy', 'full_offline'] as const) {
      const radio = page.getByTestId(`mode-${id}`);
      await expect(radio).toBeEnabled();
      await radio.check();
      await expect(radio).toBeChecked();
    }
  });
});
