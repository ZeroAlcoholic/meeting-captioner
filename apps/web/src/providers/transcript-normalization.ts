import { TAIWAN_TERM_REPLACEMENTS } from '@meeting-audio/contracts';

// The OpenCC dictionary is ~500 KB gzipped — four fifths of the main bundle if
// it is imported statically, downloaded and parsed before the page can render.
// It is only needed once captions start, so it loads alongside the token mint,
// the capture permission and the VAD model instead of ahead of the first paint.
// 'twp' converts the wording as well as the glyphs: without it a Mainland
// transcript only changes script, and 软件/默认/项目 arrive as 軟件/默認/項目.
const glossary = new RegExp(
  Object.keys(TAIWAN_TERM_REPLACEMENTS)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'gu',
);
let convertWording: ((text: string) => string) | null = null;
let loading: Promise<void> | null = null;

/**
 * Fetch the conversion dictionary. Captions must not start before it resolves:
 * a caption board that shows Mainland text and corrects it afterwards is worse
 * than one that starts a moment later.
 */
export function loadTranscriptNormalizer(): Promise<void> {
  if (convertWording) return Promise.resolve();
  loading ??= import('opencc-js/cn2t')
    .then(({ Converter }) => {
      const convertScript = Converter({ from: 'cn', to: 'twp' });
      convertWording = (text) =>
        convertScript(text).replace(glossary, (term) => TAIWAN_TERM_REPLACEMENTS[term]!);
    })
    .catch((error: unknown) => {
      loading = null;
      throw error instanceof Error ? error : new Error('Taiwanese dictionary unavailable');
    });
  return loading;
}

/** Taiwanese script and wording for a whole string, for paths that keep no provenance. */
export function toTaiwanese(text: string): string {
  if (!convertWording)
    throw new Error('Taiwanese dictionary is not loaded; transcript text unconverted');
  return convertWording(text);
}

/** Script and wording only: Latin case, punctuation, numbers and repetition survive. */
export function normalizeTranscript(raw: string): {
  text: string;
  rawText?: string;
  textNormalization?: 'opencc-cn-twp-v2';
} {
  // URLs and email identifiers are case-/byte-sensitive, including Unicode paths.
  const protectedText = /(?:https?:\/\/|www\.)[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/gu;
  let cursor = 0;
  let text = '';
  for (const match of raw.matchAll(protectedText)) {
    text += toTaiwanese(raw.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  text += toTaiwanese(raw.slice(cursor));
  return text === raw ? { text } : { text, rawText: raw, textNormalization: 'opencc-cn-twp-v2' };
}
