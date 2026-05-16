// Bundle src/server.ts into a single dist/server.bundle.cjs file.
//
// Why a bundle: pnpm deploy produces absolute-path symlinks under
// node_modules/.pnpm; Windows zip tools (incl. PowerShell Compress-Archive)
// don't preserve symlinks, so the extracted release would be missing
// @fastify/cors and friends. A single-file CJS bundle inlines every dep
// and ships zero node_modules — no symlink fragility, much smaller zip.
//
// pino-pretty is intentionally OMITTED (kept external) — pino loads it via
// a worker thread that resolves modules from the filesystem, which doesn't
// play with esbuild's bundled require. The release launchers set
// LOG_FORMAT=json so the server emits plain JSON logs and never tries to
// load pino-pretty.

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.bundle.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  sourcemap: false,
  // Pin compile-time constants so the bundle never reaches for them at
  // runtime via import.meta / package.json reads (both broken in CJS bundles).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
    __SERVER_BUNDLED__: 'true',
  },
  // Stub pino-pretty so it cannot be loaded even if a transport ref slips
  // through. The release sets LOG_FORMAT=json which avoids the code path
  // entirely; this is belt-and-suspenders.
  external: ['pino-pretty'],
  logLevel: 'info',
});
