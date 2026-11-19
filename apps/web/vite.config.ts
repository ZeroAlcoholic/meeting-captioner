import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ConfigEnv, type Plugin } from 'vite';
import { localVadAssets } from './vad-assets.js';

// Match the two capability aliases in tsconfig.app/online.json. A runtime
// branch cannot isolate static imports or their module-loading side effects.

export function createWebConfig({ mode }: ConfigEnv, onlineOnly = false) {
  const env = loadEnv(mode, process.cwd(), '');
  const isOnline = onlineOnly || (env.VITE_DEPLOYMENT_MODE ?? 'full').toLowerCase() === 'online';

  const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

  return {
    plugins: [
      react(),
      localVadAssets(),
      {
        name: 'online-local-boundary',
        load(id: string) {
          if (isOnline && /\/src\/providers\/(offline|hybrid)\//.test(id.replaceAll('\\', '/'))) {
            this.error(`Online deployment cannot import local implementation: ${id}`);
          }
        },
      } satisfies Plugin,
    ],
    define: {
      __DEPLOYMENT_MODE__: JSON.stringify(isOnline ? 'online' : 'full'),
    },
    resolve: {
      alias: [
        {
          find: '@meeting-audio/offline-stt',
          replacement: isOnline
            ? resolve('./src/providers/local-mode-unavailable.ts')
            : resolve('./src/providers/offline/use-offline-stt.ts'),
        },
        {
          find: '@meeting-audio/hybrid',
          replacement: isOnline
            ? resolve('./src/providers/local-mode-unavailable.ts')
            : resolve('./src/providers/hybrid/use-hybrid-mode.ts'),
        },
      ],
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    test: {
      // Keep discovery inside the source tree; unrelated Python caches may be
      // unreadable on Windows and must not prevent the JS suite from starting.
      include: ['src/**/*.test.{ts,tsx}'],
      // Reset the shared audio-engine cache before every test (see test-setup).
      setupFiles: ['./src/test-setup.ts'],
    },
  };
}

export default defineConfig((env) => createWebConfig(env));
