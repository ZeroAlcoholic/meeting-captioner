import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const thresholds = Object.freeze({
  chineseCer: 0.1,
  englishWer: 0.15,
  criticalTermRecall: 0.95,
  firstTextP95Ms: 2000,
  finalTextP95Ms: 3000,
});
const fail = (message) => {
  throw new Error(message);
};
const string = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}: nonempty string required`);
};
const number = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${label}: finite nonnegative number required`);
  }
};
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label}: object required`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(`${label}: unknown field ${key}`);
}
function envelope(value, label) {
  object(value, ['version', 'samples'], label);
  if (
    value.version !== 1 ||
    !Array.isArray(value.samples) ||
    (label === 'manifest' && !value.samples.length)
  ) {
    fail(`${label}: version 1 and samples array required; manifest cannot be empty`);
  }
}
const normalize = (text) => text.normalize('NFKC').toLowerCase();
const han = (text) => normalize(text).match(/\p{Script=Han}/gu) ?? [];
const words = (text) => normalize(text).match(/[a-z0-9]+(?:['’][a-z0-9]+)*/g) ?? [];
function edits(reference, hypothesis) {
  let row = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 0; i < reference.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < hypothesis.length; j++) {
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(reference[i] !== hypothesis[j])),
      );
    }
    row = next;
  }
  return row[hypothesis.length];
}
function containsTerm(text, term) {
  const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, 'u').test(normalize(text));
}
const ratio = (n, d) => (d ? n / d : null);
const p95 = (values) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;

export async function evaluate(manifest, predictions, { baseDir, split } = {}) {
  if (!['test', 'validation'].includes(split)) fail('split must explicitly be test or validation');
  string(baseDir, 'baseDir');
  envelope(manifest, 'manifest');
  envelope(predictions, 'predictions');
  const root = await realpath(baseDir);
  const ids = new Set();
  for (const s of manifest.samples) {
    object(
      s,
      [
        'id',
        'scenario',
        'split',
        'audio',
        'sha256',
        'reference',
        'referenceKind',
        'criticalTerms',
        'speechStartMs',
        'speechEndMs',
      ],
      'manifest sample',
    );
    for (const key of ['id', 'scenario', 'audio', 'reference']) string(s[key], key);
    if (ids.has(s.id)) fail(`duplicate manifest id: ${s.id}`);
    ids.add(s.id);
    if (s.split !== split) fail(`${s.id}: split differs from requested ${split}`);
    if (s.referenceKind !== 'human-transcribed')
      fail(`${s.id}: human-transcribed reference required; prompts are not gold`);
    if (!/^[a-f0-9]{64}$/.test(s.sha256 ?? '')) fail(`${s.id}: lowercase SHA-256 required`);
    if (!Array.isArray(s.criticalTerms)) fail(`${s.id}: criticalTerms array required`);
    const terms = new Set();
    for (const term of s.criticalTerms) {
      string(term, 'critical term');
      if (terms.has(normalize(term))) fail(`${s.id}: duplicate critical term`);
      terms.add(normalize(term));
      if (!containsTerm(s.reference, term))
        fail(`${s.id}: critical term absent from reference: ${term}`);
    }
    number(s.speechStartMs, 'speechStartMs');
    number(s.speechEndMs, 'speechEndMs');
    if (s.speechEndMs <= s.speechStartMs) fail(`${s.id}: speech end must follow start`);
    if (isAbsolute(s.audio)) fail(`${s.id}: audio must be relative to manifest directory`);
    const audio = await realpath(resolve(root, s.audio));
    const rel = relative(root, audio);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      fail(`${s.id}: audio escapes manifest directory`);
    const digest = createHash('sha256')
      .update(await readFile(audio))
      .digest('hex');
    if (digest !== s.sha256) fail(`${s.id}: audio SHA-256 mismatch`);
    if (!han(s.reference).length && !words(s.reference).length)
      fail(`${s.id}: no scoreable reference tokens`);
  }
  const byId = new Map();
  for (const p of predictions.samples) {
    object(p, ['id', 'text', 'firstTextMs', 'finalTextMs'], 'prediction');
    string(p.id, 'prediction id');
    if (typeof p.text !== 'string') fail(`${p.id}: prediction text must be a string`);
    if (!ids.has(p.id) || byId.has(p.id)) fail(`${p.id}: unknown or duplicate prediction`);
    for (const key of ['firstTextMs', 'finalTextMs']) if (p[key] !== undefined) number(p[key], key);
    const source = manifest.samples.find((s) => s.id === p.id);
    if (p.firstTextMs !== undefined && p.firstTextMs < source.speechStartMs)
      fail(`${p.id}: first text precedes speech`);
    if (p.finalTextMs !== undefined && p.finalTextMs < source.speechEndMs)
      fail(`${p.id}: final text precedes speech end`);
    if (p.firstTextMs !== undefined && p.finalTextMs !== undefined && p.finalTextMs < p.firstTextMs)
      fail(`${p.id}: final text precedes first text`);
    if (!p.text.trim() && p.firstTextMs !== undefined)
      fail(`${p.id}: empty transcript cannot have first text timing`);
    byId.set(p.id, p);
  }
  const missingPredictions = [];
  const missingFirstText = [];
  const missingFinalText = [];
  const first = [];
  const final = [];
  const samples = manifest.samples.map((s) => {
    const p = byId.get(s.id);
    if (!p) missingPredictions.push(s.id);
    if (p?.firstTextMs === undefined) missingFirstText.push(s.id);
    else first.push(p.firstTextMs - s.speechStartMs);
    if (p?.finalTextMs === undefined) missingFinalText.push(s.id);
    else final.push(p.finalTextMs - s.speechEndMs);
    const referenceChinese = han(s.reference);
    const referenceEnglish = words(s.reference);
    const text = p?.text ?? '';
    return {
      id: s.id,
      scenario: s.scenario,
      missingPrediction: !p,
      chineseEdits: edits(referenceChinese, han(text)),
      chineseCharacters: referenceChinese.length,
      englishEdits: edits(referenceEnglish, words(text)),
      englishWords: referenceEnglish.length,
      criticalTerms: s.criticalTerms.length,
      missingCriticalTerms: s.criticalTerms.filter((term) => !containsTerm(text, term)),
    };
  });
  const scenarios = Object.create(null);
  for (const s of samples) {
    const total = (scenarios[s.scenario] ??= {
      samples: 0,
      chineseEdits: 0,
      chineseCharacters: 0,
      englishEdits: 0,
      englishWords: 0,
      criticalTerms: 0,
      missingCriticalTerms: 0,
    });
    total.samples++;
    for (const key of [
      'chineseEdits',
      'chineseCharacters',
      'englishEdits',
      'englishWords',
      'criticalTerms',
    ])
      total[key] += s[key];
    total.missingCriticalTerms += s.missingCriticalTerms.length;
  }
  for (const s of Object.values(scenarios)) {
    s.chineseCer = ratio(s.chineseEdits, s.chineseCharacters);
    s.englishWer = ratio(s.englishEdits, s.englishWords);
    s.criticalTermRecall = ratio(s.criticalTerms - s.missingCriticalTerms, s.criticalTerms);
  }
  const latency = {
    firstTextP95Ms: p95(first),
    finalTextP95Ms: p95(final),
    measuredFirstText: first.length,
    measuredFinalText: final.length,
    missingFirstText,
    missingFinalText,
  };
  const groups = Object.values(scenarios);
  const observedGatesPass =
    !missingPredictions.length &&
    !missingFirstText.length &&
    !missingFinalText.length &&
    groups.some((s) => s.chineseCharacters) &&
    groups.some((s) => s.englishWords) &&
    groups.some((s) => s.criticalTerms) &&
    groups.every(
      (s) =>
        (s.chineseCer === null ? s.chineseEdits === 0 : s.chineseCer <= thresholds.chineseCer) &&
        (s.englishWer === null ? s.englishEdits === 0 : s.englishWer <= thresholds.englishWer) &&
        (s.criticalTermRecall === null || s.criticalTermRecall >= thresholds.criticalTermRecall),
    ) &&
    latency.firstTextP95Ms <= thresholds.firstTextP95Ms &&
    latency.finalTextP95Ms <= thresholds.finalTextP95Ms;
  return {
    version: 1,
    split,
    thresholds,
    scenarios,
    samples,
    missingPredictions,
    latency,
    observedGatesPass,
    productionReady: false,
    limitations: [
      'Human provenance, reference accuracy and corpus representativeness require review.',
      'SHA-256 verifies file identity, not genuine speech or reference alignment.',
      'Passing observed gates does not establish production readiness.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3)
      fail(
        'Usage: node scripts/mixed-caption-eval.mjs manifest.json predictions.json test|validation',
      );
    const [manifestPath, predictionsPath, split] = args;
    const report = await evaluate(
      JSON.parse(await readFile(manifestPath, 'utf8')),
      JSON.parse(await readFile(predictionsPath, 'utf8')),
      { baseDir: dirname(resolve(manifestPath)), split },
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.observedGatesPass) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
