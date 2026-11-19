import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { installOnlineMocks } from './online-mock.js';

type Scope = 'partial' | 'final' | 'start' | 'pause' | 'resume' | 'stop' | 'control';
interface Sample {
  scope: Scope;
  key: string;
  text?: string;
  startedAt: number;
  observedAt: number;
  ms: number;
}
interface Probe {
  samples: Sample[];
  superseded: number;
  pending: () => number;
  ready: () => boolean;
  control: () => void;
  cleanup: () => void;
}
declare global {
  interface Window {
    __responsiveness: Probe;
  }
}

// Diagnostic baseline, not a production/real-upstream performance certification.
// The clocks below run inside Chrome; Playwright polling is outside the measured interval.
test('foreground normalized translation → DOM and local control acknowledgement baseline', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(5000);
  const blocked: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue();
    blocked.push(url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
  // Registered later: known upstream endpoints are fulfilled by LOCAL mocks.
  const mock = await installOnlineMocks(page);
  // A slow mock SDP handshake distinguishes local button acknowledgement from ready.
  await page.route(/api\.openai\.com\/v1\/realtime\/translations\/calls/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ status: 200, contentType: 'application/sdp', body: 'mock-answer-sdp' });
  });
  await page.goto('/');
  await page.bringToFront();
  await expect(page.getByTestId('start-real')).toBeEnabled();
  await page.evaluate(async () => {
    const captionPath = '/src/store/use-caption-store.ts';
    const settingsPath = '/src/settings/use-settings-store.ts';
    const { captionStore } = await import(/* @vite-ignore */ captionPath);
    const { settingsStore } = await import(/* @vite-ignore */ settingsPath);
    type Event = { sourceSegmentId: string; targetText: string; status: string };
    type Pending = { scope: Scope; key: string; text?: string; startedAt: number };
    const monitor = (
      window as unknown as {
        __latency: { recordTranslation: (event: Event) => void };
      }
    ).__latency;
    if (!monitor) throw new Error('Real pre-coalesce latency monitor is unavailable');
    const original = monitor.recordTranslation;
    const pending = new Map<string, Pending>();
    const samples: Sample[] = [];
    let sequence = 0;
    let superseded = 0;
    const button = (id: string) =>
      document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    const visible = (element: HTMLElement | null) => Boolean(element?.getClientRects().length);
    const matches = (sample: Pending): boolean => {
      if (sample.scope === 'control') {
        return document.querySelector('[data-responsiveness-control]')?.textContent === sample.text;
      }
      if (sample.scope === 'partial' || sample.scope === 'final') {
        const target = document.querySelector<HTMLElement>('[data-testid="caption-target"]');
        if (sample.scope === 'final') {
          const translation =
            captionStore.getState().translations[sample.key.slice('final:'.length)];
          if (translation?.status !== 'final' || translation.targetText !== sample.text)
            return false;
        }
        return visible(target) && Boolean(target?.textContent?.includes(sample.text!));
      }
      if (sample.scope === 'pause') return visible(button('resume-session'));
      if (sample.scope === 'stop') {
        return (
          visible(button('start-real')) &&
          button('start-real')?.disabled === false &&
          button('stop-fake-replay')?.disabled === true &&
          !button('resume-session')
        );
      }
      return (
        visible(button('pause-session')) &&
        button('start-real')?.disabled === true &&
        !button('resume-session')
      );
    };
    const observe = () => {
      const now = performance.now();
      for (const [id, sample] of pending) {
        if (!matches(sample)) continue;
        samples.push({ ...sample, observedAt: now, ms: now - sample.startedAt });
        pending.delete(id);
      }
    };
    const observer = new MutationObserver(observe);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    monitor.recordTranslation = function (event) {
      // This is the actual normalized handler invocation, before the 33ms coalescer.
      // Provider input/transport injection time is deliberately not used.
      const scope = event.status === 'final' ? 'final' : 'partial';
      const key = `${scope}:${event.sourceSegmentId}`;
      if (scope === 'final' && pending.delete(`partial:${event.sourceSegmentId}`)) superseded++;
      if (pending.has(key)) superseded++;
      pending.set(key, { scope, key, text: event.targetText, startedAt: performance.now() });
      original.call(this, event);
    };
    const onClick = (event: MouseEvent) => {
      const id = (event.target as Element | null)?.closest('button')?.dataset.testid;
      const actions: Record<string, Scope> = {
        'start-real': 'start',
        'pause-session': 'pause',
        'resume-session': 'resume',
        'stop-fake-replay': 'stop',
      };
      const scope = id ? actions[id] : undefined;
      if (!scope) return;
      const key = `${scope}:${sequence++}`;
      pending.set(key, { scope, key, startedAt: performance.now() });
    };
    document.addEventListener('click', onClick, true);
    const control = document.createElement('output');
    control.dataset.responsivenessControl = '';
    document.body.append(control);
    window.__responsiveness = {
      samples,
      get superseded() {
        return superseded;
      },
      pending: () => pending.size,
      ready: () => settingsStore.getState().health.transport.state === 'connected',
      control: () => {
        const text = `control-${sequence++}`;
        pending.set(text, { scope: 'control', key: text, text, startedAt: performance.now() });
        setTimeout(() => {
          control.textContent = text;
        }, 60);
      },
      cleanup: () => {
        monitor.recordTranslation = original;
        observer.disconnect();
        document.removeEventListener('click', onClick, true);
        control.remove();
      },
    };
  });

  let completed = false;
  try {
    await page.evaluate(() => window.__responsiveness.control());
    await page.waitForFunction(() =>
      window.__responsiveness.samples.some((s) => s.scope === 'control'),
    );
    const control = await page.evaluate(
      () => window.__responsiveness.samples.find((s) => s.scope === 'control')!,
    );
    expect(control.ms).toBeGreaterThanOrEqual(45);

    for (let index = 0; index < 20; index++) {
      await page.getByTestId('start-real').click();
      await expect(page.getByTestId('pause-session')).toBeVisible();
      // Capture-side readiness is a separate prerequisite, never our timing endpoint.
      await expect.poll(() => mock.oaiReady()).toBe(true);
      // A candidate already has a handshake handler before SDP completes;
      // that handler deliberately ignores captions until the peer is adopted.
      await page.waitForFunction(() => window.__responsiveness.ready());
      await page.evaluate((i) => {
        const emit = window.__mock.oai.emit.bind(window.__mock.oai);
        emit({ type: 'session.input_transcript.delta', delta: `Source ${i}.` });
        emit({ type: 'session.output_transcript.delta', delta: `字幕樣本${i}：` });
        emit({ type: 'session.output_transcript.delta', delta: `最新修訂${i}` });
      }, index);
      await page.waitForFunction(
        (i) =>
          window.__responsiveness.samples.some(
            (s) => s.scope === 'partial' && s.text === `字幕樣本${i}：最新修訂${i}`,
          ),
        index,
      );
      // A unique final suffix forces a new DOM update: an already-visible draft
      // cannot accidentally count as the final's rendering acknowledgement.
      await page.evaluate((i) => {
        window.__mock.oai.emit({ type: 'session.output_transcript.delta', delta: `完成${i}。` });
        window.__mock.oai.emit({ type: 'response.output_audio_transcript.done' });
      }, index);
      await page.waitForFunction(
        (i) =>
          window.__responsiveness.samples.some(
            (s) => s.scope === 'final' && s.text === `字幕樣本${i}：最新修訂${i}完成${i}。`,
          ),
        index,
      );
      await page.getByTestId('pause-session').click();
      await expect(page.getByTestId('resume-session')).toBeVisible();
      await page.getByTestId('resume-session').click();
      await expect(page.getByTestId('pause-session')).toBeVisible();
      await expect.poll(() => mock.oaiReady()).toBe(true);
      // Resume requires fresh content, not only a completed handshake.
      // Source-only input restores health without adding translation samples.
      await expect(
        page.getByRole('status', { name: '連線已建立，等待新的字幕內容。' }),
      ).toBeVisible();
      await mock.oaiInput(`Resume source ${index}.`);
      await page.waitForFunction(() => window.__responsiveness.ready());
      await page.getByTestId('stop-fake-replay').click();
      await expect(page.getByTestId('start-real')).toBeEnabled();
    }
    completed = true;
  } finally {
    const raw = await page.evaluate(() => ({
      samples: window.__responsiveness.samples,
      superseded: window.__responsiveness.superseded,
      pending: window.__responsiveness.pending(),
      visibility: document.visibilityState,
      userAgent: navigator.userAgent,
    }));
    const scopes: Scope[] = ['partial', 'final', 'start', 'pause', 'resume', 'stop', 'control'];
    const distribution = Object.fromEntries(
      scopes.map((scope) => {
        const values = raw.samples
          .filter((s) => s.scope === scope)
          .map((s) => s.ms)
          .sort((a, b) => a - b);
        const percentile = (p: number) =>
          values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
        return [
          scope,
          {
            count: values.length,
            p50: percentile(0.5),
            p95: percentile(0.95),
            p99: percentile(0.99),
            max: values.at(-1) ?? null,
            targetMet: values.length > 0 && percentile(0.95)! <= 100 && percentile(0.99)! <= 250,
          },
        ];
      }),
    );
    const reportPath = testInfo.outputPath('caption-responsiveness.json');
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          scope:
            'Chrome foreground dev build; OpenAI translation; LOCAL mocked capture/upstream; 20 independent meetings',
          clock:
            'performance.now at normalized pre-coalesce callback / native capture click → MutationObserver DOM observation; not screen paint',
          positiveControl:
            'separate 60ms delayed test-only DOM mutation; excluded from product distributions',
          thresholds: { p95Ms: 100, p99Ms: 250, diagnosticOnly: true },
          blockedExternalRequests: blocked,
          distribution,
          ...raw,
        },
        null,
        2,
      ),
    );
    await testInfo.attach('caption-responsiveness.json', {
      path: reportPath,
      contentType: 'application/json',
    });
    await page.evaluate(() => window.__responsiveness.cleanup());
    if (completed) {
      for (const scope of scopes.filter((s) => s !== 'control')) {
        expect(
          distribution[scope]!.count,
          `${scope} complete sample coverage`,
        ).toBeGreaterThanOrEqual(20);
      }
      expect(raw.visibility).toBe('visible');
      expect(raw.superseded).toBeGreaterThanOrEqual(20);
      expect(distribution.partial!.count).toBe(20);
      expect(distribution.final!.count).toBe(20);
      expect(raw.pending).toBe(0);
    }
  }
});
