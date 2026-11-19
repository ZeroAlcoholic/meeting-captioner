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
    await expect(page.locator('section[aria-label="開會前本機檢查"]')).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('meeting-running.png') });

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('scenario-hybrid')).toBeDisabled();
    await expect(page.getByTestId('scenario-online_meeting_box')).toBeDisabled();
    await expect(page.getByTestId('scenario-physical')).toBeChecked();

    await page.getByTestId('stop-fake-replay').click();
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('scenario-hybrid')).toBeDisabled();
    await expect(page.getByTestId('scenario-picker')).toContainText('雙軌收音尚未實作');
    await expect(page.getByTestId('scenario-online_meeting_box')).toBeEnabled();
    await page.getByTestId('scenario-online_meeting_box').check();
    await expect(page.getByTestId('scenario-online_meeting_box')).toBeChecked();
    await expect(page.getByTestId('system-audio-hint')).toBeVisible();

    await expect(page.locator('body')).toContainText('歡迎參加會議。');
    await page.keyboard.press('Escape');
    const shell = await page.locator('.app-shell').boundingBox();
    expect(shell).not.toBeNull();
    expect(shell!.y + shell!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    await page.screenshot({ path: test.info().outputPath('meeting-stopped.png') });
  });

  test('legacy hybrid settings retain system capture with a visible correction', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'meeting-audio:settings:v1',
        JSON.stringify({
          v: 1,
          scenarioId: 'hybrid',
          audioSource: 'system',
        }),
      );
    });
    await page.goto('/');
    await expect(page.getByRole('status').filter({ hasText: '混合會議不可用' })).toBeVisible();
    await expect(page.getByTestId('system-audio-hint')).toBeVisible();
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('scenario-online_meeting_box')).toBeChecked();
    await expect(page.getByTestId('scenario-hybrid')).toBeDisabled();
  });

  test('Advanced Manual scenario is disabled in P1', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('settings-toggle').click();

    const advanced = page.getByTestId('scenario-advanced');
    await expect(advanced).toBeDisabled();
  });
});
