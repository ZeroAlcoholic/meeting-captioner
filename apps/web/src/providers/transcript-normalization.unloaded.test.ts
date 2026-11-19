import { describe, expect, it, vi } from 'vitest';

// Its own file: the dictionary is loaded once per module instance, so the
// unloaded and failed-load states cannot be observed next to the loaded one.
describe('transcription normalization before the dictionary is ready', () => {
  it('refuses to normalize rather than publishing the upstream text unchanged', async () => {
    const { normalizeTranscript } = await import('./transcript-normalization.js');
    expect(() => normalizeTranscript('会议 API')).toThrow();
  });

  it('reports a dictionary that cannot be loaded, and stays unusable', async () => {
    vi.resetModules();
    vi.doMock('opencc-js/cn2t', () => {
      throw new Error('dictionary unavailable');
    });
    const { loadTranscriptNormalizer, normalizeTranscript } =
      await import('./transcript-normalization.js');
    await expect(loadTranscriptNormalizer()).rejects.toThrow();
    expect(() => normalizeTranscript('会议 API')).toThrow();
    vi.doUnmock('opencc-js/cn2t');
  });
});
