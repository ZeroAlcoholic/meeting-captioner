import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Pinned local assets: no meeting browser downloads models or WASM from a CDN. */
export function localVadAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const vadRoot = dirname(require.resolve('@ricky0123/vad-web/package.json'));
  const vadRequire = createRequire(join(vadRoot, 'package.json'));
  const ortDist = dirname(vadRequire.resolve('onnxruntime-web/wasm'));
  const files = new Map([
    ['silero_vad_v5.onnx', join(vadRoot, 'dist/silero_vad_v5.onnx')],
    ['ort-wasm-simd-threaded.wasm', join(ortDist, 'ort-wasm-simd-threaded.wasm')],
    ['ort-wasm-simd-threaded.mjs', join(ortDist, 'ort-wasm-simd-threaded.mjs')],
  ]);
  return {
    name: 'local-caption-vad-assets',
    generateBundle() {
      for (const [name, path] of files)
        this.emitFile({ type: 'asset', fileName: `vad/${name}`, source: readFileSync(path) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? '').split('?')[0]?.replace(/^\/vad\//, '');
        const path = req.url?.startsWith('/vad/') && name ? files.get(name) : undefined;
        if (!path) return next();
        res.setHeader(
          'Content-Type',
          name?.endsWith('.mjs')
            ? 'text/javascript'
            : name?.endsWith('.wasm')
              ? 'application/wasm'
              : 'application/octet-stream',
        );
        res.end(readFileSync(path));
      });
    },
  };
}
