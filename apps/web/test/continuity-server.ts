import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The web package owns the Vite dependency. Keep the server in the test runner
// process so Windows teardown does not depend on killing a shell process tree.
export default async function setup() {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 5207, strictPort: true },
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    throw error;
  }
  return () => server.close();
}
