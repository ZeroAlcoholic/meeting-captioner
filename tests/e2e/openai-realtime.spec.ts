import { expect, test } from '@playwright/test';

const MOCK_CLIENT_SECRET = 'mock-ephemeral-token-xyz';

// Injected before each page load to mock browser APIs that OpenAIRealtimeProvider uses
const INIT_SCRIPT = `
(function () {
  // Mock getUserMedia
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: () => {
        // Keep parity with what the provider actually touches: getAudioTracks()
        // feeds pc.addTrack (video excluded from the SDP), getTracks() feeds
        // release/stop paths.
        const audioTrack = { kind: 'audio', stop: () => {} };
        return Promise.resolve({
          getTracks: () => [audioTrack],
          getAudioTracks: () => [audioTrack],
        });
      },
    },
  });

  // Mock AudioContext
  window.AudioContext = class MockAudioContext {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      const buf = new Float32Array(2048).fill(0.05);
      return {
        fftSize: 2048,
        getFloatTimeDomainData(out) { out.set(buf); },
        connect() {},
      };
    }
    close() { return Promise.resolve(); }
  };

  // Data channel reference — allows the test page to fire events via window.__fireDCMessage
  let _dcOnMessage = null;
  window.__fireDCMessage = (data) => {
    if (_dcOnMessage) _dcOnMessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  };

  // Mock RTCPeerConnection
  window.RTCPeerConnection = class MockRTCPeerConnection {
    constructor() {
      this.oniceconnectionstatechange = null;
    }
    get iceConnectionState() { return 'connected'; }
    createDataChannel() {
      const dc = { onmessage: null };
      _dcOnMessage = (e) => dc.onmessage && dc.onmessage(e);
      return dc;
    }
    addTrack() {}
    async createOffer() { return { type: 'offer', sdp: 'mock-sdp' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    restartIce() {}
    close() {}
  };

  // Intercept fetch to api.openai.com (covers both /translations/calls and any other endpoint)
  const _origFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    if (typeof url === 'string' && url.includes('api.openai.com')) {
      return new Response('mock-answer-sdp', { status: 200 });
    }
    return _origFetch(url, opts);
  };
})();
`;

test.describe('OpenAI Realtime provider (mocked WebRTC)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/session/info', (route) => route.fulfill({ json: { hasApiKey: true } }));
    await page.route('**/session', (route) =>
      route.fulfill({
        json: { client_secret: { value: MOCK_CLIENT_SECRET, expires_at: 9999999999 } },
      }),
    );
    await page.addInitScript(INIT_SCRIPT);
  });

  test('"Start Real" button visible when online_full mode is active', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('start-real')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId('start-real')).toBeEnabled();
  });

  test('"Start Real" button hidden when mode is not online_full', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('mode-full_offline').click();
    await expect(page.getByTestId('start-real')).toHaveCount(0);
  });

  test('Start Real → audio health: requesting_permission then connected', async ({ page }) => {
    await page.goto('/');

    // Idle baseline (panel open), then close before starting: the header Start
    // button is an outside-click that dismisses the panel, so re-open after.
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('health-audio')).toHaveAttribute('data-state', 'idle');
    await page.getByTestId('settings-toggle').click();

    await page.getByTestId('start-real').click();
    await page.getByTestId('settings-toggle').click();

    await expect(page.getByTestId('health-audio')).toHaveAttribute('data-state', 'connected', {
      timeout: 5_000,
    });
  });

  test('Start Real → transport health reaches connected', async ({ page }) => {
    await page.goto('/');

    // Start first, THEN open settings — clicking Start while the panel is open
    // would dismiss it (outside-click), hiding the in-panel health row.
    await page.getByTestId('start-real').click();
    await page.getByTestId('settings-toggle').click();

    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected', {
      timeout: 5_000,
    });
  });

  test('Realtime input transcript delta updates caption board', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('start-real').click();

    // Wait for transport connected
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected', {
      timeout: 5_000,
    });

    // Fire input transcript delta — caption board renders partials immediately
    await page.evaluate(() => {
      const w = window as Window & { __fireDCMessage?: (d: string) => void };
      w.__fireDCMessage?.(
        JSON.stringify({
          type: 'session.input_transcript.delta',
          delta: 'Testing the caption board.',
        }),
      );
    });

    await expect(page.getByTestId('caption-current')).toContainText('Testing the caption board.', {
      timeout: 3_000,
    });
  });

  test('Realtime output transcript delta updates target caption', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('start-real').click();

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected', {
      timeout: 5_000,
    });

    await page.evaluate(() => {
      const w = window as Window & { __fireDCMessage?: (d: string) => void };
      // input delta renders caption-current, output delta renders caption-target
      w.__fireDCMessage?.(
        JSON.stringify({
          type: 'session.input_transcript.delta',
          delta: 'Translation test.',
        }),
      );
      w.__fireDCMessage?.(
        JSON.stringify({
          type: 'session.output_transcript.delta',
          delta: '測試字幕板。',
        }),
      );
    });

    await expect(page.getByTestId('caption-target')).toContainText('測試字幕板。', {
      timeout: 3_000,
    });
  });

  test('Target area shows pending source while translation lags, swaps on first delta', async ({
    page,
  }) => {
    // The translation stream trails the source stream on every backend —
    // ~2–3 s per sentence on Gemini Live Translate. The big target area must
    // bridge that window with the source text that HAS arrived (dimmed,
    // tagged 翻譯中…) instead of going dead, and swap to the translation the
    // moment its first draft delta lands.
    await page.goto('/');
    await page.getByTestId('start-real').click();

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('health-transport')).toHaveAttribute('data-state', 'connected', {
      timeout: 5_000,
    });

    // Source-only window: input delta arrived, no translation yet.
    await page.evaluate(() => {
      const w = window as Window & { __fireDCMessage?: (d: string) => void };
      w.__fireDCMessage?.(
        JSON.stringify({
          type: 'session.input_transcript.delta',
          delta: 'Revenue grew strongly this quarter.',
        }),
      );
    });
    const pendingSource = page.getByTestId('pending-source');
    await expect(pendingSource).toContainText('Revenue grew strongly this quarter.', {
      timeout: 3_000,
    });
    await expect(page.getByTestId('caption-target')).toContainText('翻譯中…');

    // First translation delta lands → pending source is replaced by the real
    // translated caption.
    await page.evaluate(() => {
      const w = window as Window & { __fireDCMessage?: (d: string) => void };
      w.__fireDCMessage?.(
        JSON.stringify({
          type: 'session.output_transcript.delta',
          delta: '本季營收強勁成長。',
        }),
      );
    });
    await expect(page.getByTestId('caption-target')).toContainText('本季營收強勁成長。', {
      timeout: 3_000,
    });
    await expect(pendingSource).toHaveCount(0);
  });

  test('No API key → "Start Real" shows disabled state with tooltip', async ({ page }) => {
    await page.route('**/session/info', (route) => route.fulfill({ json: { hasApiKey: false } }));
    await page.goto('/');

    const btn = page.getByTestId('start-real');
    await expect(btn).toBeVisible({ timeout: 3_000 });
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText('No API Key');
  });
});
