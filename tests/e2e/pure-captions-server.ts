import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { e2eTempDir } from './e2e-temp.mjs';
export default async function setup() {
  process.env.PURE_TEST_AUDIO = resolve(
    process.env.PURE_TEST_AUDIO ?? '.cache/live-caption-speech.wav',
  );
  process.env.PURE_TEST_AUDIO_SHA256 = createHash('sha256')
    .update(await readFile(process.env.PURE_TEST_AUDIO))
    .digest('hex');
  process.env.NODE_ENV = 'test';
  // Every regression suite runs against the controlled upstream, so the keys are
  // stripped here and a paid call cannot happen by accident. The capture run is
  // the one caller that asks for the real upstream, and it has to say so.
  if (process.env.CAPTION_EVAL_REAL_UPSTREAM !== '1')
    for (const key of ['OPENAI_API_KEY', 'OPENAI_API_KEY_AUDIO', 'GEMINI_API_KEY'])
      delete process.env[key];
  process.env.WEB_DIST_PATH = resolve(process.env.PURE_TEST_WEB_DIST ?? 'apps/web/dist');
  // These suites run the packaged service, not the workspace sources. A bundle
  // built before a contract change still validates against the old schema and
  // rejects events the current client emits, which looks like a product fault
  // and is not one — so refuse to measure against a stale server.
  const bundlePath = resolve(
    process.env.PURE_TEST_SERVER_BUNDLE ?? '.cache/pure-release/server.cjs',
  );
  const contractsPath = resolve('packages/contracts/dist/index.js');
  const rebuild =
    'pnpm -F @meeting-audio/online exec node build-bundle.mjs --managed-output ../../.cache/pure-release/server.cjs';
  if (!existsSync(bundlePath))
    throw new Error(`Missing ${bundlePath}. Build it:
  ${rebuild}`);
  if (statSync(bundlePath).mtimeMs < statSync(contractsPath).mtimeMs)
    throw new Error(`${bundlePath} is older than the built contracts. Rebuild it:
  ${rebuild}`);
  const { buildApp } = createRequire(import.meta.url)(bundlePath);
  const instances: Array<{ close(): Promise<void> }> = [];
  const close = async () => {
    await Promise.all(instances.map((app) => app.close()));
  };
  try {
    for (const provider of ['OPENAI', 'GEMINI']) {
      process.env.MEETING_DATA_DIR = await e2eTempDir(`pure-archive-${provider.toLowerCase()}-`);
      const app = await buildApp({ sameOriginOnly: true });
      instances.push(app);
      process.env[`PURE_TEST_URL_${provider}`] = await app.listen({ port: 0, host: '127.0.0.1' });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}
