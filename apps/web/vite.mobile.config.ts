import { rename } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { createWebConfig } from './vite.config.js';

// Static phone build: no server, served from a project subpath on GitHub Pages.
// Reuses the online capability aliases (local STT / Hybrid are excluded), adds a
// relative base, and emits the phone page as the site's index.html.
const outDir = fileURLToPath(new URL('./dist-mobile', import.meta.url));

export default defineConfig((env) => {
  const base = createWebConfig(env, true);
  return {
    ...base,
    // The phone page does not use local VAD, so its model/WASM files are not shipped.
    plugins: [
      ...base.plugins.filter((plugin) => (plugin as Plugin).name !== 'local-caption-vad-assets'),
      {
        name: 'mobile-index',
        apply: 'build',
        async closeBundle() {
          await rename(`${outDir}/mobile.html`, `${outDir}/index.html`);
        },
      } satisfies Plugin,
    ],
    base: './',
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: fileURLToPath(new URL('./mobile.html', import.meta.url)) },
    },
  };
});
