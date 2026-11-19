import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runService, requestService } from '../../scripts/managed-service.mjs';
import { launchServiceChild } from '../../scripts/service-child.mjs';
import { prepareService } from '../../scripts/service-build.mjs';
import { e2eTempDir } from './e2e-temp.mjs';
import { installOnlineMocks } from './online-mock.js';
import { installRecoveryTranscription } from './service-recovery-transcription.js';

let release: ReturnType<typeof prepareService> | undefined;
for (const { provider, identityFault, purpose } of [
  { provider: 'gemini', identityFault: 'none', purpose: 'translation' },
  { provider: 'gemini', identityFault: 'workspace', purpose: 'translation' },
  { provider: 'gemini', identityFault: 'build', purpose: 'translation' },
  { provider: 'gemini', identityFault: 'missing', purpose: 'translation' },
  { provider: 'openai', identityFault: 'none', purpose: 'translation' },
  { provider: 'openai', identityFault: 'none', purpose: 'transcription' },
  { provider: 'gemini', identityFault: 'none', purpose: 'transcription' },
] as const) {
  test(`production ${provider} ${purpose} old page preserves captions across child restart: identity ${identityFault}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(10_000);
    const root = await e2eTempDir('w08-browser-');
    const environment = new Map(
      ['MEETING_DATA_DIR', 'OPENAI_API_KEY', 'OPENAI_API_KEY_AUDIO', 'GEMINI_API_KEY'].map(
        (key) => [key, process.env[key]],
      ),
    );
    process.env.MEETING_DATA_DIR = join(root, 'archive');
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_API_KEY_AUDIO = '';
    process.env.GEMINI_API_KEY = '';
    const children: Array<{ stop(): Promise<void> }> = [];
    let builds = 0;
    const service = await runService({
      root,
      preferredPort: 0,
      prepare: (id: string, signal: AbortSignal) => {
        builds++;
        return (release ??= prepareService(resolve('.'), root, id, signal));
      },
      launchChild: (options: Parameters<typeof launchServiceChild>[0]) => {
        const child = launchServiceChild(options);
        children.push(child);
        return child;
      },
    });
    const events = () => {
      const db = new DatabaseSync(join(root, 'archive', 'meetings.sqlite'), { readOnly: true });
      try {
        return db
          .prepare('SELECT envelope FROM events ORDER BY sequence')
          .all()
          .map((row) => JSON.parse(String(row.envelope)));
      } finally {
        db.close();
      }
    };
    try {
      const initial = await service.ready;
      expect(initial.phase).toBe('ready');
      const origin = initial.url;
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.routeWebSocket('**/*', (socket) => socket.close());
      const pure =
        purpose === 'transcription' ? await installRecoveryTranscription(page, provider) : null;
      const mock = pure ? null : await installOnlineMocks(page);
      const persistence = page.getByTestId(
        pure ? 'persistence-status' : 'translation-persistence-status',
      );
      let spoofIdentity = false;
      let replacementToken = '';
      let writesWithReplacementToken = 0;
      await page.route('**/local/bootstrap', async (route) => {
        const response = await route.fetch();
        if (!spoofIdentity) return route.fulfill({ response });
        const body = await response.json();
        replacementToken = body.token;
        if (identityFault === 'missing') delete body.serviceIdentity;
        else
          body.serviceIdentity[identityFault === 'workspace' ? 'workspaceId' : 'buildId'] =
            'different-service';
        return route.fulfill({ response, json: body });
      });
      page.on('request', (request) => {
        if (
          spoofIdentity &&
          replacementToken &&
          request.method() === 'POST' &&
          request.headers().authorization === `Bearer ${replacementToken}`
        )
          writesWithReplacementToken++;
      });
      mock?.setAvailableProviders([provider]);
      const connectionCount = () =>
        pure
          ? pure.connectionCount()
          : provider === 'gemini'
            ? mock!.geminiOpenSockets()
            : mock!.oaiOpenPeers();
      const mintCount = () =>
        pure
          ? pure.mintCount()
          : provider === 'gemini'
            ? mock!.geminiSessionCalls()
            : mock!.oaiSessionCalls();
      const captureCount = () => (pure ? pure.captures() : mock!.micAcquisitions());
      await page.goto(origin);
      if (pure) await pure.start();
      else await page.getByTestId(provider === 'gemini' ? 'launch-gemini' : 'launch-real').click();
      await expect.poll(connectionCount).toBe(1);
      if (!pure && provider === 'openai') await expect.poll(() => mock!.oaiReady()).toBe(true);
      const emit = async (text: string) => {
        if (pure) return pure.emit(text);
        if (provider === 'gemini')
          expect(
            await mock!.geminiServerContent({
              inputTranscription: { text },
              outputTranscription: { text: '譯文 ' + text },
              turnComplete: true,
            }),
          ).toBe(true);
        else {
          await mock!.oaiInput(text);
          await mock!.oaiOutput('譯文 ' + text);
          await mock!.oaiComplete();
        }
        await expect(page.getByTestId('caption-target')).toContainText(text);
      };
      await emit('before restart');
      await expect
        .poll(() => events().filter((event) => event.payload.kind === 'transcript').length)
        .toBe(1);
      await expect(persistence).toContainText('待保存 0 筆');
      const original = events();
      const meetingId = original[0].meetingId;
      const sockets = await connectionCount();
      const captures = await captureCount();
      const mintCalls = mintCount();
      const pageStarted = await page.evaluate(() => performance.timeOrigin);
      spoofIdentity = identityFault !== 'none';
      await children[0]!.stop();
      await emit('during restart');
      await expect(persistence).toContainText(/待保存 [1-9]/);
      await expect
        .poll(async () => (await requestService(root))?.childInstanceId)
        .not.toBe(initial.childInstanceId);
      await expect.poll(async () => (await requestService(root))?.phase).toBe('ready');
      if (identityFault === 'none')
        await expect(persistence).toContainText('待保存 0 筆', {
          timeout: 20_000,
        });
      else {
        await expect(
          page.getByRole('alert').filter({ hasText: '本機服務的工作區或版本已改變' }),
        ).toBeVisible();
        expect(events()).toEqual(original);
      }
      await emit('after restart');
      if (identityFault === 'none')
        await expect
          .poll(() => events().filter((event) => event.payload.kind === 'transcript').length)
          .toBe(3);
      else {
        expect(events()).toEqual(original);
        expect(writesWithReplacementToken).toBe(0);
      }
      expect(await connectionCount()).toBe(sockets);
      expect(await captureCount()).toBe(captures);
      expect(mintCount()).toBe(mintCalls);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageStarted);
      expect(new Set(events().map((event) => event.meetingId))).toEqual(new Set([meetingId]));
      expect(events().slice(0, original.length)).toEqual(original);
      if (pure) await page.getByRole('button', { name: '停止並保存', exact: true }).click();
      else await page.getByTestId('stop-fake-replay').click({ timeout: 10_000 });
      if (identityFault !== 'none') {
        const retry = page.getByRole('button', { name: '重試保存／結案', exact: true });
        await expect(retry).toBeVisible();
        expect(events()).toEqual(original);
        spoofIdentity = false;
        await retry.click();
      }
      await expect(persistence).toContainText(pure ? '已結案保存' : '已保存並結案');
      const exported = JSON.parse(
        await readFile(join(root, 'archive', 'exports', meetingId, 'original.json'), 'utf8'),
      );
      expect(exported.events).toEqual(events());
      expect(exported.segments.map((segment: { text: string }) => segment.text)).toEqual([
        'before restart',
        'during restart',
        'after restart',
      ]);
      const current = await requestService(root);
      expect(current.url).toBe(initial.url);
      expect(current.buildId).toBe(initial.buildId);
      expect(builds).toBe(1);
    } finally {
      await page.close().catch(() => {});
      try {
        await service.stop();
      } finally {
        for (const [key, value] of environment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  });
}
