/** Runtime-configurable service URLs. Override with VITE_ONLINE_SERVICE_URL / VITE_OFFLINE_SERVICE_URL. */
export const ONLINE_SERVICE_URL: string =
  (import.meta.env.VITE_ONLINE_SERVICE_URL as string | undefined) ?? 'http://localhost:8787';

export const OFFLINE_SERVICE_URL: string =
  (import.meta.env.VITE_OFFLINE_SERVICE_URL as string | undefined) ?? 'http://localhost:9090';
