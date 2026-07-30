import type { Page } from '@playwright/test';

/**
 * In-browser mock backend for the two online realtime providers, plus a Node
 * control surface for fault injection. This is the harness Project KEEPALIVE's
 * reliability work (zero-gap renewal, persistent reconnect, cross-model
 * failover) is verified against in a REAL browser without any cloud key.
 *
 * What it replaces (via addInitScript, before the app boots):
 *   - navigator.mediaDevices.getUserMedia / getDisplayMedia → fake MediaStream,
 *     with separate acquisition counters. The split matters: realtime "system
 *     audio" must go through display capture, not silently fall back to mic.
 *   - AudioContext / AudioWorkletNode → fake nodes; the analyser reports a
 *     controllable RMS so the receive-side wedge detector can be exercised.
 *   - RTCPeerConnection / RTCDataChannel → fake peer; DataChannel events are
 *     injected from the test (window.__mock.oai.emit). pc.close() marks its DC
 *     closed so a renewal swap's NEW channel is the one that receives events
 *     (matches real browser semantics — a closed channel never fires onmessage).
 *   - WebSocket → fake socket ONLY for the Gemini host; every other URL (Vite
 *     HMR included) is delegated to the native implementation untouched.
 *
 * What it routes (via page.route, Node side):
 *   - /session/info  → both keys present (so the Start buttons enable)
 *   - /session       → OpenAI ephemeral token; can be made to fail from the
 *     Nth call to drive the renewal-failure → failover path.
 *   - /session/gemini → Gemini ephemeral token + a translate model id.
 *   - api.openai.com .../translations/calls → a stub SDP answer.
 */

const INIT_SCRIPT = `
(function () {
  var mock = {
    getUserMediaCalls: 0,
    getDisplayMediaCalls: 0,
    streams: [],
    activeTrackCount: function () {
      var count = 0;
      for (var i = 0; i < this.streams.length; i++) {
        var tracks = this.streams[i].getTracks();
        for (var j = 0; j < tracks.length; j++) {
          if (tracks[j].readyState === 'live') count++;
        }
      }
      return count;
    },
    audioAmplitude: 0.05, // ~ -29 dBFS RMS → counts as "audio active"
    oai: {
      pcs: [],
      dcs: [],
      addedTrackKinds: [],
      emit: function (obj) {
        for (var i = this.dcs.length - 1; i >= 0; i--) {
          var d = this.dcs[i];
          if (d.readyState === 'open' && d.onmessage) {
            d.onmessage({ data: JSON.stringify(obj) });
            return true;
          }
        }
        return false;
      },
      dcCount: function () { return this.dcs.length; },
      openPeerCount: function () {
        var count = 0;
        for (var i = 0; i < this.pcs.length; i++) {
          if (this.pcs[i].connectionState !== 'closed') count++;
        }
        return count;
      },
      ready: function () {
        for (var i = this.dcs.length - 1; i >= 0; i--) {
          if (this.dcs[i].readyState === 'open' && this.dcs[i].onmessage) return true;
        }
        return false;
      },
    },
    gemini: {
      sockets: [],
      autoSetup: true,
      _last: function () {
        for (var i = this.sockets.length - 1; i >= 0; i--) {
          if (this.sockets[i].readyState === 1) return this.sockets[i];
        }
        return null;
      },
      send: function (obj) { var s = this._last(); if (s) { s._emit(obj); return true; } return false; },
      close: function () { var s = this._last(); if (s) { s.close(); return true; } return false; },
      openCount: function () {
        var n = 0;
        for (var i = 0; i < this.sockets.length; i++) if (this.sockets[i].readyState === 1) n++;
        return n;
      },
    },
  };
  window.__mock = mock;

  // ── getUserMedia / getDisplayMedia ──────────────────────────────────────────
  function fakeStream(kind) {
    var audioTrack = {
      kind: 'audio', enabled: true, readyState: 'live', id: 'fake-track',
      stop: function () { this.readyState = 'ended'; },
      addEventListener: function () {}, removeEventListener: function () {},
      getSettings: function () { return {}; },
    };
    var videoTrack = {
      kind: 'video', enabled: true, readyState: 'live', id: 'fake-video-track',
      stop: function () { this.readyState = 'ended'; },
      addEventListener: function () {}, removeEventListener: function () {},
      getSettings: function () { return {}; },
    };
    var audioTracks = [audioTrack];
    var videoTracks = kind === 'display' ? [videoTrack] : [];
    var tracks = audioTracks.concat(videoTracks);
    var stream = {
      id: 'fake-stream',
      getTracks: function () { return tracks; },
      getAudioTracks: function () { return audioTracks; },
      getVideoTracks: function () { return videoTracks; },
      addTrack: function () {}, removeTrack: function () {},
    };
    mock.streams.push(stream);
    return stream;
  }
  var md = {
    getUserMedia: function () { mock.getUserMediaCalls++; return Promise.resolve(fakeStream('user')); },
    getDisplayMedia: function () { mock.getDisplayMediaCalls++; return Promise.resolve(fakeStream('display')); },
    enumerateDevices: function () { return Promise.resolve([]); },
    addEventListener: function () {}, removeEventListener: function () {},
  };
  try {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, writable: true, value: md });
  } catch (e) {
    try { navigator.mediaDevices = md; } catch (e2) { /* noop */ }
  }

  // ── AudioContext / AudioWorkletNode ─────────────────────────────────────────
  function fillTimeDomain(out) {
    var amp = mock.audioAmplitude;
    for (var i = 0; i < out.length; i++) out[i] = amp * Math.sin(i * 0.1);
  }
  function FakeAudioContext() {
    this.state = 'running';
    this.destination = {};
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.audioWorklet = { addModule: function () { return Promise.resolve(); } };
  }
  FakeAudioContext.prototype.createMediaStreamSource = function () { return { connect: function () {}, disconnect: function () {} }; };
  FakeAudioContext.prototype.createAnalyser = function () {
    return {
      fftSize: 2048, frequencyBinCount: 1024,
      getFloatTimeDomainData: fillTimeDomain,
      getByteFrequencyData: function () {},
      connect: function () {}, disconnect: function () {},
    };
  };
  FakeAudioContext.prototype.createGain = function () { return { gain: { value: 1 }, connect: function () {}, disconnect: function () {} }; };
  FakeAudioContext.prototype.resume = function () { this.state = 'running'; return Promise.resolve(); };
  FakeAudioContext.prototype.suspend = function () { this.state = 'suspended'; return Promise.resolve(); };
  FakeAudioContext.prototype.close = function () { this.state = 'closed'; return Promise.resolve(); };
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;

  function FakeAudioWorkletNode() {
    this.port = { onmessage: null, postMessage: function () {}, close: function () {}, start: function () {} };
  }
  FakeAudioWorkletNode.prototype.connect = function () {};
  FakeAudioWorkletNode.prototype.disconnect = function () {};
  window.AudioWorkletNode = FakeAudioWorkletNode;

  // ── RTCPeerConnection / RTCDataChannel ──────────────────────────────────────
  function FakeDC() { this.readyState = 'open'; this.onmessage = null; this.onopen = null; this.onclose = null; }
  FakeDC.prototype.send = function () {};
  FakeDC.prototype.close = function () { this.readyState = 'closed'; };
  FakeDC.prototype.addEventListener = function () {};
  FakeDC.prototype.removeEventListener = function () {};

  function FakePC() {
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.ontrack = null;
    this.oniceconnectionstatechange = null;
    this.onconnectionstatechange = null;
    this.onicecandidate = null;
    this._dc = null;
    mock.oai.pcs.push(this);
  }
  FakePC.prototype.createDataChannel = function () {
    this._dc = new FakeDC();
    mock.oai.dcs.push(this._dc);
    return this._dc;
  };
  FakePC.prototype.addTrack = function (track) { mock.oai.addedTrackKinds.push(track && track.kind); return {}; };
  FakePC.prototype.createOffer = function () { return Promise.resolve({ type: 'offer', sdp: 'mock-offer-sdp' }); };
  FakePC.prototype.setLocalDescription = function () { this.iceConnectionState = 'checking'; return Promise.resolve(); };
  FakePC.prototype.setRemoteDescription = function () { this.connectionState = 'connected'; this.iceConnectionState = 'connected'; return Promise.resolve(); };
  FakePC.prototype.restartIce = function () {};
  FakePC.prototype.addEventListener = function () {};
  FakePC.prototype.removeEventListener = function () {};
  FakePC.prototype.close = function () {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    if (this._dc) this._dc.readyState = 'closed';
  };
  window.RTCPeerConnection = FakePC;

  // ── WebSocket (Gemini host only; everything else is native) ──────────────────
  var NativeWS = window.WebSocket;
  function FakeWS(url, protocols) {
    if (!/generativelanguage\\.googleapis/.test(String(url))) {
      return new NativeWS(url, protocols);
    }
    this.url = String(url);
    this.readyState = 0; // CONNECTING
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    mock.gemini.sockets.push(this);
    var self = this;
    setTimeout(function () {
      if (self.readyState !== 0) return;
      self.readyState = 1; // OPEN
      if (self.onopen) self.onopen({ type: 'open' });
    }, 0);
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  FakeWS.prototype.send = function (data) {
    if (this.readyState !== 1) return;
    // The provider sends the setup frame on open; auto-ack it with setupComplete
    // so the happy-path session goes "connected" without per-test plumbing.
    if (mock.gemini.autoSetup && typeof data === 'string' && data.indexOf('"setup"') !== -1) {
      var self = this;
      setTimeout(function () { self._emit({ setupComplete: {} }); }, 0);
    }
  };
  FakeWS.prototype._emit = function (obj) {
    if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  };
  FakeWS.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    var self = this;
    setTimeout(function () { if (self.onclose) self.onclose({ type: 'close', code: 1000, wasClean: true }); }, 0);
  };
  FakeWS.prototype.addEventListener = function () {};
  FakeWS.prototype.removeEventListener = function () {};
  window.WebSocket = FakeWS;
})();
`;

export interface OnlineMockController {
  /** Emit a raw OpenAI DataChannel event to the active data channel. */
  oaiEmit(obj: Record<string, unknown>): Promise<boolean>;
  /** Emit a source-transcript delta (drives caption-current). */
  oaiInput(delta: string): Promise<void>;
  /** Emit a translation delta (drives caption-target). */
  oaiOutput(delta: string): Promise<void>;
  /** Emit a completion event so the live segment finalizes into history. */
  oaiComplete(): Promise<void>;
  /** Emit session.closed — triggers a transparent make-before-break renewal. */
  oaiClosed(): Promise<void>;
  /** Toggle whether the /session broker returns 500 (deterministic, timing-
   *  independent — survives the idle pre-mint that also hits /session). */
  setOaiSessionFailing(failing: boolean): void;
  /** Total getUserMedia + getDisplayMedia acquisitions so far. */
  micAcquisitions(): Promise<number>;
  /** Microphone capture acquisitions so far. */
  userMediaAcquisitions(): Promise<number>;
  /** Display/system-audio capture acquisitions so far. */
  displayMediaAcquisitions(): Promise<number>;
  /** Number of OpenAI data channels created (one per peer build). */
  oaiPeerCount(): Promise<number>;
  /** Number of OpenAI peers that have not been closed. */
  oaiOpenPeers(): Promise<number>;
  /** Number of currently-live mock media tracks. */
  activeCaptureTracks(): Promise<number>;
  /** True once the active DataChannel is open AND wired (safe to emit events). */
  oaiReady(): Promise<boolean>;
  /** How many times the /session broker has been hit (for pre-mint assertions). */
  oaiSessionCalls(): number;
  /** How many times the /session/gemini broker has been hit. */
  geminiSessionCalls(): number;
  /** Track kinds added to OpenAI RTCPeerConnection. */
  oaiAddedTrackKinds(): Promise<Array<string | undefined>>;
  /** Send a raw Gemini server message to the active socket. */
  geminiSend(obj: Record<string, unknown>): Promise<boolean>;
  /** Convenience: wrap a serverContent payload. */
  geminiServerContent(sc: Record<string, unknown>): Promise<boolean>;
  /** Close the active Gemini socket (server-initiated drop). */
  geminiClose(): Promise<boolean>;
  /** Number of currently-open Gemini sockets. */
  geminiOpenSockets(): Promise<number>;
  /** Override provider availability returned by /session/info. */
  setAvailableProviders(providers: Array<'openai' | 'gemini'>): void;
  /** Set the analyser RMS amplitude (0 = silence → wedge detector idle). */
  setAudioAmplitude(a: number): Promise<void>;
}

/** Install all mocks + routes on the page and return the fault-injection controller. */
export async function installOnlineMocks(page: Page): Promise<OnlineMockController> {
  const state = {
    oaiSessionFailing: false,
    oaiSessionCalls: 0,
    geminiSessionCalls: 0,
    availableProviders: ['openai', 'gemini'] as Array<'openai' | 'gemini'>,
  };

  await page.route(/\/session\/info(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        hasApiKey: state.availableProviders.includes('openai'),
        hasGeminiKey: state.availableProviders.includes('gemini'),
        availableProviders: state.availableProviders,
      },
    }),
  );
  await page.route(/\/session\/gemini$/, (route) => {
    state.geminiSessionCalls += 1;
    return route.fulfill({
      json: {
        token: 'gemini-mock-token',
        model: 'models/gemini-3.5-live-translate-preview',
      },
    });
  });
  await page.route(/\/session$/, (route) => {
    state.oaiSessionCalls += 1;
    if (state.oaiSessionFailing) {
      return route.fulfill({
        status: 500,
        contentType: 'text/plain',
        body: 'mock /session failure',
      });
    }
    return route.fulfill({
      json: {
        client_secret: { value: 'oai-mock-secret', expires_at: 9_999_999_999 },
        session_renewal_recommended_ms: 9_999_999,
      },
    });
  });
  await page.route(/api\.openai\.com\/v1\/realtime\/translations\/calls/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/sdp', body: 'mock-answer-sdp' }),
  );

  await page.addInitScript(INIT_SCRIPT);

  // NOTE: every page.evaluate callback is serialized and run in the BROWSER, so
  // it may only reference its arguments + browser globals (window.__mock here) —
  // never module-scope helpers, which are not shipped across the boundary.
  return {
    oaiEmit: (obj) => page.evaluate((o) => window.__mock.oai.emit(o), obj),
    oaiInput: async (delta) => {
      await page.evaluate(
        (d) => window.__mock.oai.emit({ type: 'session.input_transcript.delta', delta: d }),
        delta,
      );
    },
    oaiOutput: async (delta) => {
      await page.evaluate(
        (d) => window.__mock.oai.emit({ type: 'session.output_transcript.delta', delta: d }),
        delta,
      );
    },
    oaiComplete: async () => {
      await page.evaluate(() =>
        window.__mock.oai.emit({ type: 'response.output_audio_transcript.done' }),
      );
    },
    oaiClosed: async () => {
      await page.evaluate(() => window.__mock.oai.emit({ type: 'session.closed' }));
    },
    setOaiSessionFailing: (failing) => {
      state.oaiSessionFailing = failing;
    },
    oaiSessionCalls: () => state.oaiSessionCalls,
    geminiSessionCalls: () => state.geminiSessionCalls,
    oaiAddedTrackKinds: () => page.evaluate(() => window.__mock.oai.addedTrackKinds.slice()),
    micAcquisitions: () =>
      page.evaluate(() => window.__mock.getUserMediaCalls + window.__mock.getDisplayMediaCalls),
    userMediaAcquisitions: () => page.evaluate(() => window.__mock.getUserMediaCalls),
    displayMediaAcquisitions: () => page.evaluate(() => window.__mock.getDisplayMediaCalls),
    oaiPeerCount: () => page.evaluate(() => window.__mock.oai.dcCount()),
    oaiOpenPeers: () => page.evaluate(() => window.__mock.oai.openPeerCount()),
    activeCaptureTracks: () => page.evaluate(() => window.__mock.activeTrackCount()),
    oaiReady: () => page.evaluate(() => window.__mock.oai.ready()),
    geminiSend: (obj) => page.evaluate((o) => window.__mock.gemini.send(o), obj),
    geminiServerContent: (sc) =>
      page.evaluate((s) => window.__mock.gemini.send({ serverContent: s }), sc),
    geminiClose: () => page.evaluate(() => window.__mock.gemini.close()),
    geminiOpenSockets: () => page.evaluate(() => window.__mock.gemini.openCount()),
    setAvailableProviders: (providers) => {
      state.availableProviders = providers;
    },
    setAudioAmplitude: async (a) => {
      await page.evaluate((v) => {
        window.__mock.audioAmplitude = v;
      }, a);
    },
  };
}

/** Shape of the in-page mock control surface (window.__mock). */
interface MockGlobal {
  getUserMediaCalls: number;
  getDisplayMediaCalls: number;
  activeTrackCount(): number;
  audioAmplitude: number;
  oai: {
    addedTrackKinds: Array<string | undefined>;
    emit(obj: Record<string, unknown>): boolean;
    dcCount(): number;
    openPeerCount(): number;
    ready(): boolean;
  };
  gemini: { send(obj: Record<string, unknown>): boolean; close(): boolean; openCount(): number };
}
declare global {
  interface Window {
    __mock: MockGlobal;
  }
}
