import { describe, expect, it } from 'vitest';
import { recognitionHints } from './recognition-hints.js';
import { MEETING_KEYWORDS } from '@meeting-audio/contracts';

describe('recognition hints sent upstream', () => {
  it('passes the shared meeting vocabulary through unchanged', () => {
    expect(recognitionHints(MEETING_KEYWORDS, 1000)).toEqual([...MEETING_KEYWORDS]);
  });

  it.each([['a\nb'], ['a\r\nb'], ['a<b'], ['a>b'], ['   ']])(
    'rejects a term upstream cannot accept: %j',
    (term) => {
      expect(() => recognitionHints([term], 1000)).toThrow();
    },
  );

  it('rejects duplicates rather than silently collapsing them', () => {
    expect(() => recognitionHints(['API', 'API'], 1000)).toThrow(/duplicate/i);
  });

  it('reports going over the limit instead of truncating', () => {
    const terms = Array.from({ length: 11 }, (_, i) => `term-${i}`);
    expect(() => recognitionHints(terms, 10)).toThrow(/limit/i);
    expect(recognitionHints(terms.slice(0, 10), 10)).toHaveLength(10);
  });
});
