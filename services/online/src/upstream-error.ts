const codes: Readonly<Record<string, string>> = Object.freeze({
  ENOTFOUND: 'UPSTREAM_DNS',
  EAI_AGAIN: 'UPSTREAM_DNS',
  CERT_HAS_EXPIRED: 'UPSTREAM_TLS',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'UPSTREAM_TLS',
  SELF_SIGNED_CERT_IN_CHAIN: 'UPSTREAM_TLS',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'UPSTREAM_TLS',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'UPSTREAM_TLS',
  ERR_TLS_CERT_ALTNAME_INVALID: 'UPSTREAM_TLS',
  ECONNREFUSED: 'UPSTREAM_CONNECTION_REFUSED',
  ECONNRESET: 'UPSTREAM_CONNECTION_RESET',
  ENETUNREACH: 'UPSTREAM_NETWORK_UNREACHABLE',
  EHOSTUNREACH: 'UPSTREAM_NETWORK_UNREACHABLE',
  ETIMEDOUT: 'UPSTREAM_TIMEOUT',
  UND_ERR_CONNECT_TIMEOUT: 'UPSTREAM_TIMEOUT',
});

/** Only allowlisted native codes; messages/URLs and proxy responses are private. */
export function upstreamErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'UPSTREAM_TIMEOUT';
  const cause = error instanceof Error ? error.cause : undefined;
  const value = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return typeof value === 'string' && Object.hasOwn(codes, value)
    ? codes[value]!
    : 'UPSTREAM_REQUEST_FAILED';
}
