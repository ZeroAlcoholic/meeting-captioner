// Runtime-configurable service URLs.
//
// Resolution rules:
//
//   ONLINE service (`services/online`)
//   - VITE_ONLINE_SERVICE_URL wins if explicitly set.
//   - Production builds default to '' (same-origin). The slim distribution
//     bundles the web into the online server, so they live on one port.
//   - Dev defaults to http://localhost:8787 so Vite at :5173 can reach the
//     standalone Fastify dev process.
//
//   OFFLINE service (`services/offline`)
//   - VITE_OFFLINE_SERVICE_URL wins if explicitly set.
//   - Otherwise ALWAYS default to http://localhost:8000 (dev and prod).
//     The offline FastAPI is a separate Python process on the user's
//     machine; it never gets bundled into anything, so same-origin would
//     wrongly point the browser at the web host. Slim builds tree-shake
//     the offline code entirely so this constant is unreferenced there.

function resolveOnline(): string {
  const explicit = import.meta.env.VITE_ONLINE_SERVICE_URL as string | undefined;
  if (explicit !== undefined) return explicit;
  if (import.meta.env.PROD) return '';
  return 'http://localhost:8787';
}

function resolveOffline(): string {
  const explicit = import.meta.env.VITE_OFFLINE_SERVICE_URL as string | undefined;
  if (explicit !== undefined) return explicit;
  return 'http://localhost:8000';
}

export const ONLINE_SERVICE_URL: string = resolveOnline();
export const OFFLINE_SERVICE_URL: string = resolveOffline();
