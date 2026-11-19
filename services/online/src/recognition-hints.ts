/**
 * Vocabulary hints for the transcription models. Both upstreams treat them as
 * hints, never as required output, so a malformed list degrades recognition
 * silently — it is checked here instead, where the failure is visible.
 *
 * OpenAI `keywords`: one term per line, no `<` or `>`.
 * Gemini `custom_vocabulary`: at most 1,000 terms.
 */
export function recognitionHints(terms: readonly string[], limit: number): string[] {
  if (terms.length > limit)
    throw new Error(`Recognition hints exceed the upstream limit of ${limit} terms`);
  const seen = new Set<string>();
  return terms.map((term) => {
    if (typeof term !== 'string' || !term.trim())
      throw new Error('Recognition hint must be a nonempty term');
    if (/[\r\n<>]/.test(term))
      throw new Error('Recognition hint must be one line and free of < or >');
    const key = term.toLowerCase();
    // Truncating or collapsing would spend the budget on a list nobody checked.
    if (seen.has(key)) throw new Error(`Duplicate recognition hint: ${term}`);
    seen.add(key);
    return term;
  });
}
