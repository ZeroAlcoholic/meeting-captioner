import { afterEach, expect, it, vi } from 'vitest';

it.each([
  'OPENAI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED',
  'GEMINI_TRANSCRIPTION_CONCURRENT_RENEWAL_ALLOWED',
])('%s requires an explicit strict boolean deployment qualification', async (name) => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [value, expected] of [
    [undefined, false],
    ['false', false],
    ['true', true],
  ] as const) {
    vi.resetModules();
    vi.stubEnv(name, value);
    const { config } = await import('./config.js');
    expect((config as Record<string, unknown>)[name]).toBe(expected);
  }
  for (const value of ['TRUE', '1', 'yes', 'flase', '']) {
    vi.resetModules();
    vi.stubEnv(name, value);
    await expect(import('./config.js')).rejects.toThrow();
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('normalizes blank keys and reports an audio-only environment as available', async () => {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', '   ');
  vi.stubEnv('OPENAI_API_KEY_AUDIO', ' test-audio ');
  vi.stubEnv('GEMINI_API_KEY', '\t');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { config } = await import('./config.js');
  expect(config.OPENAI_API_KEY).toBeUndefined();
  expect(config.GEMINI_API_KEY).toBeUndefined();
  expect(config.OPENAI_API_KEY_AUDIO).toBe('test-audio');
  expect(log.mock.calls.flat().join(' ')).not.toContain('MISSING');
  expect(log.mock.calls.flat().join(' ')).not.toContain('test-audio');
});
