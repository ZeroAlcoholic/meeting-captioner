// Re-export barrel for the offline STT hook.
//
// Resolved by Vite alias `@meeting-audio/offline-stt` to either
// `use-offline-stt.real.ts` (full build) or `use-offline-stt.stub.ts`
// (online-slim build). See vite.config.ts.
//
// Importers should ALWAYS go through this file so the alias takes effect.
export { useOfflineSTT } from '@meeting-audio/offline-stt';
