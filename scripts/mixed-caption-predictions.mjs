/**
 * Turns what the caption board actually showed into the predictions file
 * `mixed-caption-eval.mjs` scores. Every time is measured on one monotonic
 * clock and reported relative to the moment that sample's audio started.
 */

const relativeMark = (mark, audioStartMs, label, id) => {
  if (mark === undefined) return undefined;
  if (!Number.isFinite(mark)) throw new Error(`${id}: ${label} must be a finite measurement`);
  const offset = Math.round(mark - audioStartMs);
  // A mark before the audio began means the two were taken from different
  // clocks; reporting it would quietly produce a flattering latency.
  if (offset < 0) throw new Error(`${id}: ${label} is before the audio started`);
  return offset;
};

/**
 * @param {{ id: string, text?: string, audioStartMs: number,
 *           firstTextAtMs?: number, finalTextAtMs?: number }[]} observations
 */
export function buildPredictions(observations) {
  const seen = new Set();
  const samples = observations.map((observation) => {
    const { id, audioStartMs } = observation;
    if (typeof id !== 'string' || !id.trim()) throw new Error('prediction: nonempty id required');
    if (seen.has(id)) throw new Error(`prediction: duplicate id ${id}`);
    seen.add(id);
    if (!Number.isFinite(audioStartMs))
      throw new Error(`${id}: audioStartMs must be a finite measurement`);
    const firstTextMs = relativeMark(observation.firstTextAtMs, audioStartMs, 'firstTextMs', id);
    const finalTextMs = relativeMark(observation.finalTextAtMs, audioStartMs, 'finalTextMs', id);
    return {
      id,
      text: typeof observation.text === 'string' ? observation.text : '',
      // An unmeasured mark is left out: the scorer reports it as missing, and a
      // zero would read as an instant caption.
      ...(firstTextMs === undefined ? {} : { firstTextMs }),
      ...(finalTextMs === undefined ? {} : { finalTextMs }),
    };
  });
  return { version: 1, samples };
}
