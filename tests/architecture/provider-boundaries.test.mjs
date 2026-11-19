import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const webRoot = resolve(root, 'apps/web');
const require = createRequire(resolve(root, 'package.json'));
const webRequire = createRequire(resolve(webRoot, 'package.json'));
const ts = require('typescript');
const { build } = await import(
  pathToFileURL(resolve(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js'))
    .href
);
const isLocalImplementation = (id) =>
  /\/src\/providers\/(?:offline\/|hybrid\/|offline-stt-provider\.|use-offline-stt\.real\.|use-hybrid-mode\.)/.test(
    id.replaceAll('\\', '/'),
  );

test('online compiler ignores broken local implementations while full still checks them', () => {
  const compile = (profile) => {
    const onlineConfig = resolve(webRoot, 'tsconfig.online.json');
    const configPath =
      profile === 'online' && existsSync(onlineConfig)
        ? onlineConfig
        : resolve(webRoot, 'tsconfig.app.json');
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    );
    assert.deepEqual(parsed.errors, []);
    const host = ts.createCompilerHost(parsed.options);
    const load = host.getSourceFile.bind(host);
    let poisoned = 0;
    host.getSourceFile = (path, languageVersion, ...args) => {
      if (isLocalImplementation(path)) {
        poisoned++;
        return ts.createSourceFile(
          path,
          'export const localFailure: string = 42;',
          languageVersion,
        );
      }
      return load(path, languageVersion, ...args);
    };
    const program = ts.createProgram(parsed.fileNames, parsed.options, host);
    return { poisoned, diagnostics: ts.getPreEmitDiagnostics(program) };
  };
  const online = compile('online');
  assert.equal(
    online.poisoned,
    0,
    'online compiler must not load local implementation or test files',
  );
  assert.deepEqual(
    online.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
  const full = compile('full');
  assert.ok(full.poisoned > 0, 'full deployment must retain local implementation checks');
  assert.ok(
    full.diagnostics.some((d) => d.code === 2322),
    'full must expose the injected local type error',
  );
});

async function buildOnline(plugins = []) {
  const previous = process.env.VITE_DEPLOYMENT_MODE;
  process.env.VITE_DEPLOYMENT_MODE = 'online';
  try {
    return await build({ root: webRoot, logLevel: 'silent', build: { write: false }, plugins });
  } finally {
    if (previous === undefined) delete process.env.VITE_DEPLOYMENT_MODE;
    else process.env.VITE_DEPLOYMENT_MODE = previous;
  }
}

test('online bundling works even when every local implementation loader fails', async () => {
  const result = await buildOnline([
    {
      name: 'poison-local-implementations',
      enforce: 'pre',
      load(id) {
        if (isLocalImplementation(id)) throw new Error(`Local implementation loaded: ${id}`);
      },
    },
  ]);
  const outputs = Array.isArray(result) ? result.flatMap((r) => r.output) : result.output;
  const modules = outputs
    .filter((item) => item.type === 'chunk')
    .flatMap((item) => Object.keys(item.modules));
  assert.ok(modules.some((id) => id.endsWith('/providers/openai-realtime-provider.ts')));
  assert.ok(modules.some((id) => id.endsWith('/providers/gemini-live-provider.ts')));
  assert.ok(
    modules.some((id) => id.endsWith('/providers/transcription-audio.ts')),
    'online still needs shared local PCM/VAD capture',
  );
  assert.deepEqual(modules.filter(isLocalImplementation), []);
});

test('online build rejects a newly introduced direct import of a local provider', async () => {
  await assert.rejects(
    buildOnline([
      {
        name: 'inject-accidental-local-import',
        enforce: 'pre',
        load(id) {
          if (id.replaceAll('\\', '/') === resolve(webRoot, 'src/main.tsx').replaceAll('\\', '/')) {
            return `${readFileSync(id, 'utf8')}\nimport './providers/offline/offline-stt-provider.ts';`;
          }
        },
      },
    ]),
    /Online deployment cannot import local implementation/,
  );
});
