import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluate } from './mixed-caption-eval.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'caption-eval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('local audio fixture');
  await writeFile(join(dir, 'sample.wav'), bytes);
  return {
    dir,
    manifest: {
      version: 1,
      samples: [
        {
          id: 'one',
          scenario: 'code-switch',
          split: 'test',
          audio: 'sample.wav',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          reference: '今天 deploy API',
          referenceKind: 'human-transcribed',
          criticalTerms: ['API'],
          speechStartMs: 100,
          speechEndMs: 1100,
        },
      ],
    },
    predictions: {
      version: 1,
      samples: [{ id: 'one', text: '今天 deploy API', firstTextMs: 500, finalTextMs: 1500 }],
    },
  };
}

test('scores a verified human reference and applies unchanged quality gates', async (t) => {
  const f = await fixture(t);
  const result = await evaluate(f.manifest, f.predictions, { baseDir: f.dir, split: 'test' });
  assert.equal(result.scenarios['code-switch'].chineseCer, 0);
  assert.equal(result.scenarios['code-switch'].englishWer, 0);
  assert.equal(result.scenarios['code-switch'].criticalTermRecall, 1);
  assert.equal(result.latency.firstTextP95Ms, 400);
  assert.equal(result.latency.finalTextP95Ms, 400);
  assert.deepEqual(result.thresholds, {
    chineseCer: 0.1,
    englishWer: 0.15,
    criticalTermRecall: 0.95,
    firstTextP95Ms: 2000,
    finalTextP95Ms: 3000,
  });
  assert.equal(result.observedGatesPass, true);
  assert.equal(result.productionReady, false);
});

test('reports per-example term loss, script errors, and missing samples', async (t) => {
  const f = await fixture(t);
  f.manifest.samples.push({ ...f.manifest.samples[0], id: 'two' });
  f.predictions.samples[0].text = '今 deploy';
  const result = await evaluate(f.manifest, f.predictions, { baseDir: f.dir, split: 'test' });
  assert.deepEqual(result.missingPredictions, ['two']);
  assert.deepEqual(result.samples[0].missingCriticalTerms, ['API']);
  assert.equal(result.samples[0].chineseEdits, 1);
  assert.equal(result.samples[0].englishEdits, 1);
  assert.equal(result.observedGatesPass, false);
});

test('rejects audio hash mismatch, prompt-only gold, wrong split and duplicate IDs', async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (m) => {
      m.samples[0].sha256 = '0'.repeat(64);
    },
    (m) => {
      m.samples[0].referenceKind = 'prompt';
    },
    (m) => {
      m.samples[0].split = 'train';
    },
    (m) => {
      m.samples.push({ ...m.samples[0] });
    },
  ]) {
    const manifest = structuredClone(f.manifest);
    mutate(manifest);
    await assert.rejects(evaluate(manifest, f.predictions, { baseDir: f.dir, split: 'test' }));
  }
});

test('missing timing is explicit and cannot pass latency gates', async (t) => {
  const f = await fixture(t);
  delete f.predictions.samples[0].firstTextMs;
  const result = await evaluate(f.manifest, f.predictions, { baseDir: f.dir, split: 'test' });
  assert.deepEqual(result.latency.missingFirstText, ['one']);
  assert.equal(result.latency.firstTextP95Ms, null);
  assert.equal(result.observedGatesPass, false);
});

test('term matching respects English word boundaries and nearest-rank p95', async (t) => {
  const f = await fixture(t);
  f.predictions.samples[0].text = '今天 deploy RAPID';
  f.predictions.samples[0].firstTextMs = 2201;
  f.predictions.samples[0].finalTextMs = 2500;
  const result = await evaluate(f.manifest, f.predictions, { baseDir: f.dir, split: 'test' });
  assert.deepEqual(result.samples[0].missingCriticalTerms, ['API']);
  assert.equal(result.latency.firstTextP95Ms, 2101);
  assert.equal(result.observedGatesPass, false);
});

test('rejects unexpected predictions and nonfinite/invalid timing', async (t) => {
  const f = await fixture(t);
  const extra = structuredClone(f.predictions);
  extra.samples.push({ id: 'unknown', text: 'hi' });
  await assert.rejects(evaluate(f.manifest, extra, { baseDir: f.dir, split: 'test' }));
  for (const value of [-1, Infinity, '500']) {
    const bad = structuredClone(f.predictions);
    bad.samples[0].firstTextMs = value;
    await assert.rejects(evaluate(f.manifest, bad, { baseDir: f.dir, split: 'test' }));
  }
});

test('an empty prediction set reports every missing sample', async (t) => {
  const f = await fixture(t);
  f.predictions.samples = [];
  const result = await evaluate(f.manifest, f.predictions, { baseDir: f.dir, split: 'test' });
  assert.deepEqual(result.missingPredictions, ['one']);
  assert.equal(result.scenarios['code-switch'].chineseCer, 1);
  assert.equal(result.scenarios['code-switch'].englishWer, 1);
  assert.equal(result.observedGatesPass, false);
});

test('nearest-rank p95 uses the 19th of 20 measurements', async (t) => {
  const f = await fixture(t);
  const source = f.manifest.samples[0];
  const prediction = f.predictions.samples[0];
  f.manifest.samples = Array.from({ length: 20 }, (_, i) => ({ ...source, id: `sample-${i}` }));
  f.predictions.samples = f.manifest.samples.map((s, i) => ({
    ...prediction,
    id: s.id,
    firstTextMs: s.speechStartMs + (i + 1) * 10,
  }));
  const result = await evaluate(f.manifest, f.predictions, { baseDir: f.dir, split: 'test' });
  assert.equal(result.latency.firstTextP95Ms, 190);
});
