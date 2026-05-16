import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Build-time alias swap so the offline path is fully tree-shaken from the
// online-slim distribution. The barrel `src/providers/use-offline-stt.ts`
// resolves to either the real module or a tiny stub based on
// VITE_DEPLOYMENT_MODE.
//
// Why an alias instead of a runtime branch: static `import` statements are
// hoisted regardless of which branch consumes them, so a runtime check
// cannot eliminate the offline module from the bundle. Aliasing rewrites
// the resolved path before the bundler ever sees the offline source.

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const deploymentMode = (env.VITE_DEPLOYMENT_MODE ?? 'full').toLowerCase();
  const isOnline = deploymentMode === 'online';

  const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

  return {
    plugins: [react()],
    define: {
      __DEPLOYMENT_MODE__: JSON.stringify(isOnline ? 'online' : 'full'),
    },
    resolve: {
      alias: [
        {
          find: '@meeting-audio/offline-stt',
          replacement: isOnline
            ? resolve('./src/providers/use-offline-stt.stub.ts')
            : resolve('./src/providers/use-offline-stt.real.ts'),
        },
      ],
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
