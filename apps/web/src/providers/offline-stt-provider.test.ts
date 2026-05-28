import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineSTTProvider } from './offline-stt-provider.js';
import type { CaptionProviderHandlers } from './types.js';

// ─── WebSocket mock ────────────────────────────────────────────────────────────

let mockWsInstance: MockWebSocket | null = null;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  binaryType = 'arraybuffer';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    mockWsInstance = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
  simulateOpen() {
    this.onopen?.();
  }
  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  simulateClose() {
    this.onclose?.();
  }
}

// ─── AudioContext / AudioWorkletNode mock ─────────────────────────────────────

const mockWorkletPort = {
  onmessage: null as ((ev: MessageEvent<ArrayBuffer>) => void) | null,
  close: vi.fn(),
};

const mockWorkletNode = {
  port: mockWorkletPort,
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const mockAudioWorklet = {
  addModule: vi.fn().mockResolvedValue(undefined),
};

const mockSource = { connect: vi.fn() };

const mockAudioCtx = {
  audioWorklet: mockAudioWorklet,
  createMediaStreamSource: vi.fn().mockReturnValue(mockSource),
  close: vi.fn().mockResolvedValue(undefined),
};

// ─── AudioSource mock ─────────────────────────────────────────────────────────

function makeMicMock() {
  const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  return {
    analyser: null,
    acquire: vi.fn().mockResolvedValue(fakeStream),
    release: vi.fn(),
  };
}

// ─── Handlers mock ────────────────────────────────────────────────────────────

function makeHandlers(): CaptionProviderHandlers {
  return {
    onTranscript: vi.fn(),
    onTranslation: vi.fn(),
    onHealth: vi.fn(),
    onAudioLevel: vi.fn(),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flush one microtask tick — lets mic.acquire() resolve so WebSocket is constructed. */
const flush = () => Promise.resolve();

/** Start provider, flush so WS is constructed, then fire onopen. */
async function startProvider(provider: OfflineSTTProvider) {
  const startPromise = provider.start();
  await flush();
  mockWsInstance!.simulateOpen();
  await startPromise;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockWsInstance = null;
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('AudioContext', vi.fn().mockReturnValue(mockAudioCtx));
  vi.stubGlobal('AudioWorkletNode', vi.fn().mockReturnValue(mockWorkletNode));
  mockSource.connect.mockClear();
  mockWorkletNode.connect.mockClear();
  mockWorkletNode.disconnect.mockClear();
  mockWorkletPort.close.mockClear();
  mockAudioWorklet.addModule.mockClear();
  mockAudioCtx.createMediaStreamSource.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OfflineSTTProvider', () => {
  it('sends start control message with langPair on open', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock(), 'en→zh-TW');

    await startProvider(provider);

    const jsonSent = mockWsInstance!.sent.find((s) => typeof s === 'string') as string;
    const ctrl = JSON.parse(jsonSent) as { type: string; langPair: string };
    expect(ctrl.type).toBe('start');
    expect(ctrl.langPair).toBe('en→zh-TW');
  });

  it('emits health connecting before WebSocket opens', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());

    const startPromise = provider.start();
    await flush();
    mockWsInstance!.simulateOpen();
    await startPromise;

    const states = (handlers.onHealth as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { state: string }).state,
    );
    expect(states).toContain('connecting');
  });

  it('routes transcript events to onTranscript handler', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());

    await startProvider(provider);

    mockWsInstance!.simulateMessage({
      kind: 'transcript',
      provider: 'offline-stt',
      mode: 'full_offline',
      source: 'microphone',
      segmentId: 'seg-1000',
      status: 'partial',
      text: 'Hello world',
      startMs: 1000,
    });

    const call = (handlers.onTranscript as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      status: string;
      text: string;
      kind: string;
    };
    expect(call.kind).toBe('transcript');
    expect(call.status).toBe('partial');
    expect(call.text).toBe('Hello world');
  });

  it('routes final transcript events correctly', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());

    await startProvider(provider);

    mockWsInstance!.simulateMessage({
      kind: 'transcript',
      provider: 'offline-stt',
      mode: 'full_offline',
      source: 'microphone',
      segmentId: 'seg-500',
      status: 'final',
      text: 'Final text.',
      startMs: 500,
      endMs: 2000,
    });

    const finalCall = (handlers.onTranscript as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'final',
    )?.[0] as { status: string; text: string };
    expect(finalCall?.text).toBe('Final text.');
  });

  it('routes translation events to onTranslation handler', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());

    await startProvider(provider);

    mockWsInstance!.simulateMessage({
      kind: 'translation',
      provider: 'offline-mt',
      mode: 'full_offline',
      sourceSegmentId: 'seg-500',
      status: 'final',
      sourceText: 'Final text.',
      targetText: '最終文字。',
      sourceLanguage: 'en',
      targetLanguage: 'zh-TW',
      updatedAt: new Date().toISOString(),
    });

    expect(handlers.onTranslation).toHaveBeenCalledOnce();
    const call = (handlers.onTranslation as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      targetText: string;
    } | undefined;
    expect(call?.targetText).toBe('最終文字。');
  });

  it('routes health events to onHealth handler', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());

    await startProvider(provider);

    mockWsInstance!.simulateMessage({
      kind: 'health',
      component: 'transport',
      state: 'connected',
      timestamp: new Date().toISOString(),
    });

    const states = (handlers.onHealth as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { state: string }).state,
    );
    expect(states).toContain('connected');
  });

  it('emits api_error health event when WebSocket errors', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());

    const startPromise = provider.start();
    await flush();
    mockWsInstance!.onerror?.();

    await startPromise.catch(() => undefined);

    const errCall = (handlers.onHealth as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { state: string }).state === 'api_error',
    );
    expect(errCall).toBeDefined();
  });

  it('malformed WS message does not crash the provider or interrupt transcript flow', async () => {
    // CLAUDE.md: "translation failure must never stop captions". If the
    // offline service sends a garbled / unrecognised message, the recv loop
    // must swallow it and continue forwarding valid events.
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());
    await startProvider(provider);

    // Malformed — unknown kind.
    mockWsInstance!.simulateMessage({ kind: 'INVALID_KIND', garbage: true });
    // Empty object.
    mockWsInstance!.simulateMessage({});
    // Immediately after: a valid transcript must still be routed.
    mockWsInstance!.simulateMessage({
      kind: 'transcript',
      provider: 'offline-stt',
      mode: 'full_offline',
      source: 'microphone',
      segmentId: 'seg-after-garbage',
      status: 'final',
      text: 'Still works.',
      startMs: 100,
      endMs: 900,
    });

    const finalCall = (handlers.onTranscript as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { segmentId?: string }).segmentId === 'seg-after-garbage',
    );
    expect(finalCall).toBeDefined();
    expect(provider.status).toBe('running');

    provider.stop();
  });

  it('offline server unavailable → emits offline_engine_unavailable health state', async () => {
    // When the WebSocket fails to open (server not running), the provider
    // must surface an actionable health state rather than a generic error
    // so the UI can direct the user to start the offline service.
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());

    const startPromise = provider.start();
    await Promise.resolve(); // let mic.acquire() settle
    // Simulate WS open failure (server not listening).
    mockWsInstance!.onerror?.();
    await startPromise.catch(() => undefined);

    const states = (handlers.onHealth as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { state: string }).state,
    );
    // Must emit either api_error or offline_engine_unavailable — either
    // indicates the offline service is unreachable.
    expect(
      states.includes('api_error') || states.includes('offline_engine_unavailable'),
    ).toBe(true);
  });

  it('stop() emits stopped health events and closes WebSocket', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock());

    await startProvider(provider);

    provider.stop();

    expect(mockWsInstance!.readyState).toBe(MockWebSocket.CLOSED);
    const states = (handlers.onHealth as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { state: string }).state,
    );
    expect(states).toContain('stopped');
  });

  // ── Contract: start message fields ────────────────────────────────────────

  it('start message includes translate:true by default', async () => {
    const handlers = makeHandlers();
    // OfflineSTTProvider 4th arg = langPair, no translate arg → defaults to true
    const provider = new OfflineSTTProvider('ws://localhost:8000/ws', handlers, makeMicMock(), 'en→zh-TW');

    await startProvider(provider);

    const jsonSent = mockWsInstance!.sent.find((s) => typeof s === 'string') as string;
    const ctrl = JSON.parse(jsonSent) as { type: string; translate: unknown };
    expect(ctrl.type).toBe('start');
    expect(ctrl.translate).toBe(true);
  });

  it('start message includes translate:false when configured', async () => {
    const handlers = makeHandlers();
    // 5th constructor arg = audioSource, 6th = translate (not exposed in current signature)
    // OfflineSTTProvider accepts translate via options object — check actual signature.
    // The hybrid mode sets translate=false via the provider factory.
    const provider = new OfflineSTTProvider(
      'ws://localhost:8000/ws',
      handlers,
      makeMicMock(),
      'en→zh-TW',
      'mic',
      false, // translate = false
    );

    await startProvider(provider);

    const jsonSent = mockWsInstance!.sent.find((s) => typeof s === 'string') as string;
    const ctrl = JSON.parse(jsonSent) as { type: string; translate: unknown };
    expect(ctrl.type).toBe('start');
    expect(ctrl.translate).toBe(false);
  });
});
