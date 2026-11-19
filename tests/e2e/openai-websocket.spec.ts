import { expect, test, type WebSocketRoute } from '@playwright/test';
import { installOnlineMocks } from './online-mock.js';

test('OpenAI WebSocket fallback and renewal render separate captions and release capture', async ({
  page,
}) => {
  const mock = await installOnlineMocks(page);
  mock.setAvailableProviders(['openai']);
  const requests: Array<Record<string, unknown>> = [];
  await page.route(/\/session$/, (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      json: {
        client_secret: { value: 'test-ephemeral', expires_at: 9_999_999_999 },
        key_slot: 'primary',
        session_renewal_recommended_ms: 9_999_999,
      },
    });
  });
  await page.route(/api\.openai\.com\/v1\/realtime\/translations\/calls/, (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'ip_not_authorized' } } }),
  );

  // Route the network boundary only: the production WS transport, activation,
  // provider, normalized events, store and React board all execute in Chrome.
  const sockets: WebSocketRoute[] = [];
  const closed = new Set<WebSocketRoute>();
  await page.routeWebSocket('wss://api.openai.com/v1/realtime/translations', (socket) => {
    sockets.push(socket);
    socket.onClose(() => closed.add(socket));
    socket.onMessage((message) => {
      const event = JSON.parse(String(message)) as { type: string };
      if (event.type === 'session.close') {
        socket.send(
          JSON.stringify({ type: 'session.output_transcript.delta', delta: '補回尾字。' }),
        );
        socket.send(JSON.stringify({ type: 'session.closed' }));
      }
    });
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.send(
      JSON.stringify({
        type: 'session.output_transcript.delta',
        delta: sockets.length === 1 ? '原連線字幕。' : '接管後字幕。',
      }),
    );
  });

  await page.goto('/');
  await page.getByTestId('start-real').click();
  await expect(page.getByTestId('caption-target')).toContainText('原連線字幕。');
  expect(await mock.micAcquisitions()).toBe(1);
  expect(await mock.oaiOpenPeers()).toBe(0);

  sockets[0]!.send(JSON.stringify({ type: 'session.closed' }));
  await expect(page.getByTestId('caption-target')).toContainText('接管後字幕。');
  await expect(page.getByTestId('caption-history')).toContainText('原連線字幕。補回尾字。');
  await expect(page.getByTestId('caption-target')).not.toContainText('原連線字幕。');
  await expect(page.getByTestId('caption-target')).toContainText('接管後字幕。');
  await expect(page.getByTestId('caption-target')).not.toContainText('補回尾字。');
  expect(await mock.micAcquisitions()).toBe(1);
  expect(requests.every((request) => request.rejectedSlot === undefined)).toBe(true);
  await expect.poll(() => closed.has(sockets[0]!)).toBe(true);

  await page.getByTestId('stop-fake-replay').click();
  await expect.poll(() => mock.activeCaptureTracks()).toBe(0);
  await expect(page.locator('body')).toContainText('接管後字幕。補回尾字。');
  await expect.poll(() => closed.size).toBe(sockets.length);
});
