import type { RecoveryFailure } from '@meeting-audio/contracts';

/** Four fixed scopes survive adapter/session replacement, not a second retry owner. */
const failures = new Map<string, RecoveryFailure>();
type Backend = RecoveryFailure['provider'];
type Purpose = RecoveryFailure['purpose'];
/** Known protocol status/code only; human error messages are not classification evidence. */
export function protocolRecoveryKind(value: unknown): RecoveryFailure['kind'] {
  const error = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const evidence = [error.status, error.status_code, error.code];
  const limited = new Set<unknown>([
    429,
    'rate_limit_exceeded',
    'insufficient_quota',
    'RESOURCE_EXHAUSTED',
  ]);
  const auth = new Set<unknown>([
    401,
    403,
    'invalid_api_key',
    'ip_not_authorized',
    'UNAUTHENTICATED',
    'PERMISSION_DENIED',
  ]);
  const unsupported = new Set<unknown>([
    400,
    404,
    405,
    410,
    413,
    415,
    422,
    'model_not_found',
    'invalid_request_error',
    'INVALID_ARGUMENT',
    'NOT_FOUND',
    'UNIMPLEMENTED',
  ]);
  if (evidence.some((value) => limited.has(value))) return 'rate-limit';
  if (evidence.some((value) => auth.has(value))) return 'auth';
  if (evidence.some((value) => unsupported.has(value))) return 'unsupported';
  return 'network';
}
export class RecoveryError extends Error {
  constructor(
    readonly failure: RecoveryFailure,
    message: string,
  ) {
    super(message);
  }
}
export function recoveryFailureFor(
  provider: Backend,
  purpose: Purpose,
): RecoveryFailure | undefined {
  return failures.get(`${provider}:${purpose}`);
}
export function permanentRecoveryFailure(failure: RecoveryFailure | undefined): boolean {
  return failure?.kind === 'auth' || failure?.kind === 'unsupported';
}
export function clearRecoveryRefusal(provider: Backend, purpose: Purpose): void {
  const previous = recoveryFailureFor(provider, purpose);
  if (!permanentRecoveryFailure(previous)) return;
  if (previous && (previous.retryNotBeforeMs ?? 0) > performance.now()) {
    failures.set(`${provider}:${purpose}`, { ...previous, kind: 'rate-limit' });
  } else failures.delete(`${provider}:${purpose}`);
}
export function assertRecoveryAllowed(provider: Backend, purpose: Purpose): void {
  const failure = recoveryFailureFor(provider, purpose);
  if (
    failure &&
    (permanentRecoveryFailure(failure) || (failure.retryNotBeforeMs ?? 0) > performance.now())
  ) {
    throw new RecoveryError(
      failure,
      `${provider}: ${failure.kind}${failure.kind === 'rate-limit' ? ' (HTTP 429)' : ''}; automatic retry unavailable`,
    );
  }
}
export function recoveryError(
  kind: RecoveryFailure['kind'],
  provider: Backend,
  purpose: Purpose,
  message: string,
  retryNotBeforeMs?: number,
): RecoveryError {
  const failure: RecoveryFailure = {
    layer: kind === 'network' ? 'transport' : 'provider',
    kind,
    provider,
    purpose,
    attemptId: crypto.randomUUID(),
    ...(retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs }),
  };
  const previous = recoveryFailureFor(provider, purpose);
  const deadline = Math.max(previous?.retryNotBeforeMs ?? 0, retryNotBeforeMs ?? 0);
  const retained = permanentRecoveryFailure(previous)
    ? previous!
    : !permanentRecoveryFailure(failure) && deadline > performance.now()
      ? { ...failure, layer: 'provider' as const, kind: 'rate-limit' as const }
      : failure;
  const effective = { ...retained, ...(deadline > 0 ? { retryNotBeforeMs: deadline } : {}) };
  failures.set(`${provider}:${purpose}`, effective);
  return new RecoveryError(
    effective,
    effective.kind === kind ? message : `${provider} ${purpose}: ${effective.kind}`,
  );
}
export function recoveryHttpError(
  response: Response,
  provider: Backend,
  purpose: Purpose,
): RecoveryError {
  const status = response.status;
  const kind = protocolRecoveryKind({ status });
  let deadline: number | undefined;
  if (kind === 'rate-limit') {
    const value = response.headers.get('Retry-After')?.trim();
    const delay =
      value && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value) * 1000
        : value
          ? Date.parse(value) - Date.now()
          : NaN;
    deadline = performance.now() + (Number.isFinite(delay) ? Math.max(0, delay) : 15_000);
  }
  return recoveryError(
    kind,
    provider,
    purpose,
    `${provider} ${purpose}: ${kind} (HTTP ${status})`,
    deadline,
  );
}
export function normalizeRecoveryError(
  error: unknown,
  provider: Backend,
  purpose: Purpose,
): RecoveryError {
  return error instanceof RecoveryError
    ? error
    : recoveryError(
        'network',
        provider,
        purpose,
        `${provider} ${purpose}: connection failed or timed out`,
      );
}
export function __resetRecoveryFailuresForTests(): void {
  failures.clear();
}

/** One immutable owner and one deadline across a complete network attempt.
 * User permission waits belong outside this scope. dispose() releases resources
 * after success; cancel() additionally prevents any pending/late result adoption.
 */
export const RECOVERY_ATTEMPT_TIMEOUT_MS = 12_000;

/** Distinguish an expired local wait from native rejection or user cancellation. */
export class RecoveryTimeoutError extends Error {}

export interface RecoveryAttempt {
  readonly signal: AbortSignal;
  readonly generation: number;
  assertActive(): void;
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancel(reason?: Error): void;
  dispose(): void;
}

export function createRecoveryAttempt(options: {
  parentSignal?: AbortSignal;
  generation: number;
  isCurrent: (generation: number) => boolean;
  timeoutMs?: number;
  label?: string;
}): RecoveryAttempt {
  const controller = new AbortController();
  const cancel = (reason: Error = new DOMException('Recovery attempt cancelled', 'AbortError')) =>
    controller.abort(reason);
  const parentCancelled = () => controller.abort(options.parentSignal?.reason);
  if (options.parentSignal?.aborted) parentCancelled();
  else options.parentSignal?.addEventListener('abort', parentCancelled, { once: true });
  const timer = setTimeout(
    () => cancel(new RecoveryTimeoutError(`${options.label ?? 'Recovery attempt'} timed out`)),
    options.timeoutMs ?? RECOVERY_ATTEMPT_TIMEOUT_MS,
  );
  const assertActive = () => {
    if (!options.isCurrent(options.generation))
      cancel(new DOMException('Recovery attempt superseded', 'AbortError'));
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    generation: options.generation,
    assertActive,
    cancel,
    dispose() {
      clearTimeout(timer);
      options.parentSignal?.removeEventListener('abort', parentCancelled);
    },
    async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      assertActive();
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const work = (async () => operation(controller.signal))();
        const value = await Promise.race([cancelled, work]);
        assertActive();
        return value;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
