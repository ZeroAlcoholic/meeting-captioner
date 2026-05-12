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

// ─── AudioContext / ScriptProcessorNode mock ──────────────────────────────────

const mockScriptNode = {
  onaudioprocess: null as ((ev: AudioProcessingEvent) => void) | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const mockSource = { connect: vi.fn() };

const mockAudioCtx = {
  createMediaStreamSource: vi.fn().mockReturnValue(mockSource),
  createScriptProcessor: vi.fn().mockReturnValue(mockScriptNode),
  destination: {},
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

/** Start provider, flush so WS is constructed, then fire SERVER_READY. */
async function startProvider(provider: OfflineSTTProvider) {
  const startPromise = provider.start();
  await flush();
  mockWsInstance!.simulateOpen();
  mockWsInstance!.simulateMessage({ uid: 'x', message: 'SERVER_READY' });
  await startPromise;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockWsInstance = null;
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('AudioContext', vi.fn().mockReturnValue(mockAudioCtx));
  mockSource.connect.mockClear();
  mockScriptNode.connect.mockClear();
  mockScriptNode.disconnect.mockClear();
  mockAudioCtx.createMediaStreamSource.mockClear();
  mockAudioCtx.createScriptProcessor.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OfflineSTTProvider', () => {
  it('emits health connecting then connected on successful start', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:9090', handlers, makeMicMock());

    await startProvider(provider);

    const states = (handlers.onHealth as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { state: string }).state,
    );
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
  });

  it('sends uid+config JSON after WebSocket opens', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:9090', handlers, makeMicMock());

    await startProvider(provider);

    const jsonSent = mockWsInstance!.sent.find((s) => typeof s === 'string') as string;
    const config = JSON.parse(jsonSent) as { language: string; task: string; model: string };
    expect(config.language).toBe('en');
    expect(config.task).toBe('transcribe');
    expect(config.model).toBe('small');
  });

  it('emits partial TranscriptEvent for non-completed segment', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:9090', handlers, makeMicMock());

    await startProvider(provider);

    mockWsInstance!.simulateMessage({
      uid: 'x',
      segments: [{ start: 0, end: 1.5, text: 'Hello world', completed: false }],
    });

    const call = (handlers.onTranscript as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      status: string;
      text: string;
      provider: string;
    };
    expect(call.status).toBe('partial');
    expect(call.text).toBe('Hello world');
    expect(call.provider).toBe('offline-stt');
  });

  it('emits final TranscriptEvent for completed segment', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:9090', handlers, makeMicMock());

    await startProvider(provider);

    mockWsInstance!.simulateMessage({
      uid: 'x',
      segments: [{ start: 0, end: 2.0, text: 'Final text.', completed: true }],
    });

    const finalCall = (handlers.onTranscript as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'final',
    )?.[0] as { status: string; text: string };
    expect(finalCall?.text).toBe('Final text.');
    expect(finalCall?.status).toBe('final');
  });

  it('does not re-emit a completed segment already finalized', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:9090', handlers, makeMicMock());

    await startProvider(provider);

    const seg = { start: 0, end: 2.0, text: 'Once only.', completed: true };
    mockWsInstance!.simulateMessage({ uid: 'x', segments: [seg] });
    mockWsInstance!.simulateMessage({ uid: 'x', segments: [seg] });

    const finalCalls = (handlers.onTranscript as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { status: string }).status === 'final',
    );
    expect(finalCalls).toHaveLength(1);
  });

  it('emits api_error health event when WebSocket errors', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:9090', handlers, makeMicMock());

    const startPromise = provider.start();
    await flush(); // let mic.acquire() resolve → WS is now constructed
    mockWsInstance!.onerror?.();

    await startPromise.catch(() => undefined);

    const errCall = (handlers.onHealth as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { state: string }).state === 'api_error',
    );
    expect(errCall).toBeDefined();
  });

  it('stop() emits stopped health events and closes WebSocket', async () => {
    const handlers = makeHandlers();
    const provider = new OfflineSTTProvider('ws://localhost:9090', handlers, makeMicMock());

    await startProvider(provider);

    provider.stop();

    expect(mockWsInstance!.readyState).toBe(MockWebSocket.CLOSED);
    const states = (handlers.onHealth as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { state: string }).state,
    );
    expect(states).toContain('stopped');
  });
});
