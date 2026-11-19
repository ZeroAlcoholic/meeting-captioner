import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPredictions } from './mixed-caption-predictions.mjs';
import { evaluate } from './mixed-caption-eval.mjs';

const observation = {
  id: 'mix-01',
  text: '這個 sprint 的 scope 先 freeze。',
  audioStartMs: 1000,
  firstTextAtMs: 1600,
  finalTextAtMs: 3200,
};

test('times are relative to the audio start, on one clock', () => {
  assert.deepEqual(buildPredictions([observation]), {
    version: 1,
    samples: [{ id: 'mix-01', text: observation.text, firstTextMs: 600, finalTextMs: 2200 }],
  });
});

test('an unmeasured mark is omitted, never reported as zero', () => {
  const { samples } = buildPredictions([{ ...observation, firstTextAtMs: undefined }]);
  assert.equal('firstTextMs' in samples[0], false);
  assert.equal(samples[0].finalTextMs, 2200);
});

test('rejects a duplicate id, a blank id and a mark before the audio started', () => {
  assert.throws(() => buildPredictions([observation, observation]), /duplicate/);
  assert.throws(() => buildPredictions([{ ...observation, id: ' ' }]), /id/);
  assert.throws(() => buildPredictions([{ ...observation, firstTextAtMs: 900 }]), /before/);
});

test('the result passes the scorer unchanged', async () => {
  // Schema fixture only: silent audio and an authored reference. It exercises
  // the scorer's prediction validation and makes no recognition-quality claim.
  const dir = await mkdtemp(path.join(tmpdir(), 'caption-eval-fixture-'));
  const wav = Buffer.alloc(64);
  await writeFile(path.join(dir, 'fixture.wav'), wav);
  const manifest = {
    version: 1,
    samples: [
      {
        id: 'mix-01',
        scenario: 'schema-fixture',
        split: 'test',
        audio: 'fixture.wav',
        sha256: createHash('sha256').update(wav).digest('hex'),
        referenceKind: 'human-transcribed',
        reference: '這個 sprint 的 scope 先 freeze。',
        criticalTerms: ['sprint', 'scope', 'freeze'],
        speechStartMs: 100,
        speechEndMs: 2000,
      },
    ],
  };
  const report = await evaluate(manifest, buildPredictions([observation]), {
    baseDir: dir,
    split: 'test',
  });
  assert.deepEqual(report.missingPredictions, []);
  assert.deepEqual(report.latency.missingFirstText, []);
  assert.deepEqual(report.latency.missingFinalText, []);
  assert.equal(report.latency.firstTextP95Ms, 500);
  assert.equal(report.latency.finalTextP95Ms, 200);
});
