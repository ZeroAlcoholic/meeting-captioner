/**
 * Single source of truth for the build-time deployment mode.
 *
 * - `online`  — cloud distribution: OpenAI/Gemini. Local STT and Hybrid
 *               implementations are excluded through Vite/TypeScript aliases.
 *               Shared PCM, VAD and Traditional Chinese processing remain.
 * - `full`    — default: includes both online and offline paths.
 *
 * Override with `VITE_DEPLOYMENT_MODE=online` at build time. The flag is
 * inlined by Vite's `define` so dead-code elimination can drop the unused
 * UI branches in App.tsx and the settings store.
 */
export type DeploymentMode = 'online' | 'full';

declare const __DEPLOYMENT_MODE__: DeploymentMode;

// `__DEPLOYMENT_MODE__` is replaced at build time by Vite's `define`. The
// fallback path is for any code that runs before `define` has injected the
// global (e.g. a test runner that uses vitest defaults).
function readDeploymentMode(): DeploymentMode {
  try {
    if (typeof __DEPLOYMENT_MODE__ === 'string') return __DEPLOYMENT_MODE__;
  } catch {
    // not defined — fall through
  }
  const envValue = (import.meta.env.VITE_DEPLOYMENT_MODE as string | undefined)?.toLowerCase();
  return envValue === 'online' ? 'online' : 'full';
}

export const DEPLOYMENT_MODE: DeploymentMode = readDeploymentMode();

export const IS_ONLINE_ONLY: boolean = DEPLOYMENT_MODE === 'online';
export const IS_FULL: boolean = DEPLOYMENT_MODE === 'full';
