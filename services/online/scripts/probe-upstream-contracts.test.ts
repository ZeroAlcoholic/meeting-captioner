import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertRedacted,
  redactOpenAIResponse,
  validateGeminiGolden,
  verifyFixtureDirectory,
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

  it('reads and validates both stored fixtures instead of trusting probe completion', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'meeting-audio-contracts-'));
    const openAI = {
      provider: 'openai',
      model: 'gpt-realtime-translate',
      response: { value: '<ephemeral-token>' },
    };
    const gemini = {
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

    try {
      await expect(verifyFixtureDirectory(fixtureDir)).rejects.toThrowError(
        'missing upstream contract fixture',
      );

      await writeFile(
        path.join(fixtureDir, 'openai-realtime-translate.json'),
        JSON.stringify(openAI),
      );
      await writeFile(path.join(fixtureDir, 'gemini-live-translate.json'), JSON.stringify(gemini));

      await expect(verifyFixtureDirectory(fixtureDir)).resolves.toEqual({
        openAI,
        gemini,
      });

      await writeFile(
        path.join(fixtureDir, 'openai-realtime-translate.json'),
        JSON.stringify({
          ...openAI,
          response: {
            ...openAI.response,
            expires_at: 1_754_000_000,
            session: { id: 'sess-unredacted', model: 'gpt-realtime-translate' },
          },
        }),
      );
      await expect(verifyFixtureDirectory(fixtureDir)).rejects.toThrowError(
        'unredacted upstream contract field',
      );
      await writeFile(
        path.join(fixtureDir, 'openai-realtime-translate.json'),
        JSON.stringify(openAI),
      );

      await writeFile(
        path.join(fixtureDir, 'gemini-live-translate.json'),
        JSON.stringify({ ...gemini, model: 'models/native-audio-fallback' }),
      );
      await expect(verifyFixtureDirectory(fixtureDir)).rejects.toThrowError(
        'invalid Gemini golden contract',
      );
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
