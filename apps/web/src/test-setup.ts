import { beforeEach } from 'vitest';
import { __resetAudioEngineForTests } from './providers/audio-engine.js';
import { __resetWarmSessionForTests } from './providers/openai-realtime-provider.js';
import { __resetWarmGeminiForTests } from './providers/gemini-live-provider.js';
import { latencyMonitor } from './providers/latency-monitor.js';
import { __resetFieldTestRecorderForTests } from './providers/field-test-recorder.js';

// Process-wide caches that must be cleared before each test so state can't leak
// between tests:
//  - the audio engine's shared AudioContext + worklet (tests stub AudioContext
//    per-test, so a cached mock context would bleed into the next test);
//  - the pre-warmed ephemeral-token caches (a token minted in one test must not
//    be consumed by the next).
beforeEach(() => {
  __resetAudioEngineForTests();
  __resetWarmSessionForTests();
  __resetWarmGeminiForTests();
  latencyMonitor.reset();
  __resetFieldTestRecorderForTests();
});
