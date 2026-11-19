import { expect, test } from '@playwright/test';
import { installOnlineMocks } from './online-mock.js';

test('a deadline-split date stays readable in the live board and after finalization', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  await page.goto('/');
  await page.getByTestId('start-real').click();
  await expect.poll(() => mock.oaiReady()).toBe(true);

  await mock.oaiOutput('下一次審查是九月十五');
  // Keep the real provider active past its hard deadline without completing
  // the translation. This reproduces the actual cloud stream's split date.
  for (let tick = 0; tick < 23; tick++) {
    await page.waitForTimeout(500);
    await mock.oaiInput(' ');
  }
  await expect(page.getByTestId('caption-current')).toHaveAttribute('data-status', 'final');
  await mock.oaiOutput('日');
  await expect(page.getByTestId('caption-target')).toHaveText('下一次審查是九月十五日');
  await expect(page.getByTestId('caption-current')).toHaveAttribute('data-status', 'final');
  await expect(page.getByTestId('caption-target')).toHaveText('下一次審查是九月十五日');

  await mock.oaiOutput('下一個議題。');
  await expect(page.getByTestId('caption-target')).toHaveText('下一個議題。');
  await page.getByTestId('stop-fake-replay').click();
});
