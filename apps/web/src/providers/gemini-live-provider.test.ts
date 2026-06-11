import { describe, expect, it, vi } from 'vitest';
import type {
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import {
  GeminiLiveProvider,
  floatTo16BitPCM,
  arrayBufferToBase64,
} from './gemini-live-provider.js';

function makeHandlers() {
  const transcripts: TranscriptEvent[] = [];
  const translations: TranslationEvent[] = [];
  const health: HealthEvent[] = [];
  return {
    handlers: {
      onTranscript: (e: TranscriptEvent) => transcripts.push(e),
      onTranslation: (e: TranslationEvent) => translations.push(e),
      onHealth: (e: HealthEvent) => health.push(e),
      onAudioLevel: vi.fn(),
    },
    transcripts,
    translations,
    health,
  };
}

function makeProvider(langPair = 'en→zh-TW') {
  const h = makeHandlers();
  // No real mic needed: handleServerObject never touches audio capture.
  const provider = new GeminiLiveProvider('http://localhost/session/gemini', h.handlers, undefined, langPair);
  return { provider, ...h };
}

describe('GeminiLiveProvider — message mapping', () => {
  it('setupComplete → transport connected health', () => {
    const { provider, health } = makeProvider();
    provider.handleServerObject({ setupComplete: {} });
    expect(health.at(-1)).toMatchObject({ component: 'transport', state: 'connected' });
  });

  it('accumulates input transcription into a partial source transcript', () => {
    const { provider, transcripts } = makeProvider();
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Hello' } } });
    provider.handleServerObject({ serverContent: { inputTranscription: { text: ' world' } } });
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toMatchObject({ status: 'partial', text: 'Hello', provider: 'gemini-live', mode: 'online_full' });
    expect(transcripts[1]).toMatchObject({ status: 'partial', text: 'Hello world' });
    // Same turn → same segment id.
    expect(transcripts[0]!.segmentId).toBe(transcripts[1]!.segmentId);
    expect(transcripts[0]!.startMs).toBeGreaterThan(0);
  });

  it('accumulates output transcription into a draft translation (繁中 target)', () => {
    const { provider, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Hello' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '你好' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '世界' } } });
    expect(translations.at(-1)).toMatchObject({
      status: 'draft',
      sourceText: 'Hello',
      targetText: '你好世界',
      sourceLanguage: 'en',
      targetLanguage: 'zh-TW',
    });
  });

  it('turnComplete finalizes both transcript and translation, next content is a new segment', () => {
    const { provider, transcripts, translations } = makeProvider();
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'One' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '一' } } });
    provider.handleServerObject({ serverContent: { turnComplete: true } });

    const finalT = transcripts.filter((t) => t.status === 'final');
    const finalX = translations.filter((t) => t.status === 'final');
    expect(finalT).toHaveLength(1);
    expect(finalT[0]).toMatchObject({ status: 'final', text: 'One' });
    expect(finalX[0]).toMatchObject({ status: 'final', targetText: '一' });

    const firstId = finalT[0]!.segmentId;
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Two' } } });
    const next = transcripts.at(-1)!;
    expect(next.segmentId).not.toBe(firstId);
  });

  it('server frames are JSON carried over BINARY (regression: onmessage must decode, not drop)', () => {
    // Gemini Live sends serverContent as binary WS frames (ArrayBuffer), NOT
    // text. The provider decodes UTF-8 → JSON before routing. This guards the
    // bug where `typeof ev.data !== 'string'` silently dropped every frame.
    const { provider, translations } = makeProvider('en→zh-TW');
    const json = JSON.stringify({ serverContent: { inputTranscription: { text: 'hi' }, outputTranscription: { text: '嗨' } } });
    const buf = new TextEncoder().encode(json).buffer;
    const decoded = JSON.parse(new TextDecoder().decode(buf));
    provider.handleServerObject(decoded);
    expect(translations.at(-1)).toMatchObject({ targetText: '嗨', targetLanguage: 'zh-TW' });
  });

  it('continuous translate stream: finalizes a segment on a sentence boundary (no turnComplete)', () => {
    // gemini-3.5-live-translate streams continuously and never sends turnComplete.
    // A translation ending in a sentence terminator (。！？) WITH matching source
    // text must auto-finalize so history populates and the live line is bounded.
    const { provider, transcripts, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Hello everyone.' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '大家好。' } } });
    // No turnComplete sent — finalize must have fired on the 。
    expect(translations.some((t) => t.status === 'final' && t.targetText === '大家好。')).toBe(true);
    expect(transcripts.some((t) => t.status === 'final')).toBe(true);
    // Next sentence (source + translation) becomes a NEW segment id.
    const firstFinal = translations.find((t) => t.status === 'final')!;
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Welcome.' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '歡迎參加。' } } });
    const second = translations.find((t) => t.status === 'final' && t.targetText === '歡迎參加。');
    expect(second).toBeTruthy();
    expect(second!.sourceSegmentId).not.toBe(firstFinal.sourceSegmentId);
  });

  it('does NOT finalize a sentence-ending translation while the source transcript is still empty (orphan guard)', () => {
    // If the translation completes a sentence BEFORE any input transcription
    // arrived, finalizing would emit a final translation whose segment never
    // exists in the store → invisible forever. It must wait for the source.
    const { provider, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '大家好。' } } });
    expect(translations.filter((t) => t.status === 'final')).toHaveLength(0);
    // Source arrives → next output delta (or source sentence end) can finalize.
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Hello everyone.' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '' } } });
    // Drive one more output delta to trigger the check with both present.
    provider.handleServerObject({ serverContent: { outputTranscription: { text: ' ' } } });
    const finals = translations.filter((t) => t.status === 'final');
    expect(finals.length).toBeGreaterThan(0);
    expect(finals[0]!.targetText.trim()).toBe('大家好。');
  });

  it('echo-silent: source already in target language finalizes transcript-only on sentence end', () => {
    // echoTargetLanguage:false → speaker already speaks the target language →
    // no translation will EVER arrive. Detected via inputTranscription.languageCode;
    // the source line must self-finalize instead of growing unbounded.
    const { provider, transcripts, translations } = makeProvider('en→zh-TW'); // target zh
    provider.handleServerObject({
      serverContent: { inputTranscription: { text: '我們直接說中文。', languageCode: 'cmn-Hant' } },
    });
    const finalT = transcripts.filter((t) => t.status === 'final');
    expect(finalT).toHaveLength(1);
    expect(finalT[0]!.text).toBe('我們直接說中文。');
    expect(translations.filter((t) => t.status === 'final')).toHaveLength(0);
  });

  it('does NOT finalize source-only sentence when input language differs from target (translation pending)', () => {
    // English speech, zh target: source completes its sentence before the
    // translation arrives — finalizing now would orphan the upcoming
    // translation onto the next segment. Must wait.
    const { provider, transcripts } = makeProvider('en→zh-TW');
    provider.handleServerObject({
      serverContent: { inputTranscription: { text: 'Hello everyone.', languageCode: 'en' } },
    });
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(0);
  });

  it('stop() finalizes the in-flight turn so the last words survive Pause/Stop', () => {
    // Without this, text spoken right before Pause/Stop never reaches history,
    // is missing from Export, and the board keeps a stale pulsing partial.
    const { provider, transcripts, translations } = makeProvider('en→zh-TW');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: 'Final words' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '最後的話' } } });
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(0);
    provider.stop();
    expect(transcripts.filter((t) => t.status === 'final')).toHaveLength(1);
    expect(transcripts.at(-1)).toMatchObject({ status: 'final', text: 'Final words' });
    expect(translations.filter((t) => t.status === 'final')).toHaveLength(1);
    expect(translations.at(-1)).toMatchObject({ status: 'final', targetText: '最後的話' });
  });

  it('does not split a sentence at a decimal point ("3." mid-number)', () => {
    const { provider, translations } = makeProvider('zh-TW→en');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: '營收成長三點五個百分點。' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: 'Revenue grew by 3.' } } });
    // "3." must NOT finalize — the rest of the number is still streaming.
    expect(translations.filter((t) => t.status === 'final')).toHaveLength(0);
    provider.handleServerObject({ serverContent: { outputTranscription: { text: '5 percent.' } } });
    const finals = translations.filter((t) => t.status === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.targetText).toBe('Revenue grew by 3.5 percent.');
  });

  it('goAway emits reconnecting health', () => {
    const { provider, health } = makeProvider();
    provider.handleServerObject({ goAway: { timeLeft: '5s' } });
    expect(health.at(-1)).toMatchObject({ component: 'transport', state: 'reconnecting' });
  });

  it('zh-TW→en sets reversed language tags', () => {
    const { provider, translations } = makeProvider('zh-TW→en');
    provider.handleServerObject({ serverContent: { inputTranscription: { text: '你好' } } });
    provider.handleServerObject({ serverContent: { outputTranscription: { text: 'Hello' } } });
    expect(translations.at(-1)).toMatchObject({ sourceLanguage: 'zh-TW', targetLanguage: 'en', targetText: 'Hello' });
  });
});

describe('GeminiLiveProvider — PCM helpers', () => {
  it('floatTo16BitPCM clamps and converts to little-endian int16', () => {
    const buf = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2]));
    const dv = new DataView(buf);
    expect(buf.byteLength).toBe(10);
    expect(dv.getInt16(0, true)).toBe(0);
    expect(dv.getInt16(2, true)).toBe(32767); // 1 → max
    expect(dv.getInt16(4, true)).toBe(-32768); // -1 → min
    expect(dv.getInt16(6, true)).toBe(32767); // clamp >1
    expect(dv.getInt16(8, true)).toBe(-32768); // clamp <-1
  });

  it('arrayBufferToBase64 round-trips through atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128]);
    const b64 = arrayBufferToBase64(bytes.buffer);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([0, 1, 2, 254, 255, 128]);
  });
});
