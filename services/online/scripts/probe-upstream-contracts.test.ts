import { describe, expect, it } from 'vitest';
import {
  assertRedacted,
  redactOpenAIResponse,
  validateGeminiGolden,
} from './probe-upstream-contracts.js';

describe('upstream contract probe redaction', () => {
  it('redacts OpenAI ephemeral credentials and unstable expiries', () => {
    expect(
      redactOpenAIResponse({
        value: 'ek-live-secret',
        expires_at: 1_754_000_000,
        session: {
          id: 'sess-live-id',
          type: 'realtime',
          model: 'gpt-realtime-translate',
          expires_at: 1_754_000_000,
        },
      }),
    ).toEqual({
      value: '<ephemeral-token>',
      expires_at: '<unix-seconds>',
      session: {
        id: '<session-id>',
        type: 'realtime',
        model: 'gpt-realtime-translate',
        expires_at: '<unix-seconds>',
      },
    });
  });

  it('rejects a fixture that still contains any source secret', () => {
    expect(() =>
      assertRedacted({ token: 'ephemeral-live-value' }, ['server-api-key', 'ephemeral-live-value']),
    ).toThrowError('redaction failure');
  });

  it('accepts only the dedicated Gemini translate setup and setupComplete ack', () => {
    const golden = {
      provider: 'gemini',
      model: 'models/gemini-3.5-live-translate-preview',
      clientFrame: {
        setup: {
          model: 'models/gemini-3.5-live-translate-preview',
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: {},
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: {
              targetLanguageCode: 'zh-Hant',
              echoTargetLanguage: false,
            },
          },
        },
      },
      serverFrame: { setupComplete: {} },
    };

    expect(validateGeminiGolden(golden)).toEqual(golden);
    expect(() =>
      validateGeminiGolden({
        ...golden,
        model: 'models/gemini-2.5-flash-native-audio-preview',
      }),
    ).toThrowError('invalid Gemini golden contract');
  });
});
