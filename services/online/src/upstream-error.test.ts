import { expect, it } from 'vitest';
import { upstreamErrorCode } from './upstream-error.js';

it.each([
  ['ENOTFOUND', 'UPSTREAM_DNS'],
  ['EAI_AGAIN', 'UPSTREAM_DNS'],
  ['CERT_HAS_EXPIRED', 'UPSTREAM_TLS'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'UPSTREAM_TLS'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UPSTREAM_TLS'],
  ['ECONNREFUSED', 'UPSTREAM_CONNECTION_REFUSED'],
  ['ECONNRESET', 'UPSTREAM_CONNECTION_RESET'],
  ['ENETUNREACH', 'UPSTREAM_NETWORK_UNREACHABLE'],
  ['UND_ERR_CONNECT_TIMEOUT', 'UPSTREAM_TIMEOUT'],
])('classifies known native fetch cause %s', (code, expected) => {
  expect(upstreamErrorCode(new TypeError('fetch failed', { cause: { code } }))).toBe(expected);
});

it('retains timeout classification and never returns arbitrary error data', () => {
  expect(upstreamErrorCode(new DOMException('private URL', 'TimeoutError'))).toBe(
    'UPSTREAM_TIMEOUT',
  );
  for (const error of [
    null,
    'private credentials',
    { code: 'secret' },
    new Error('private URL'),
    new Error('failed', { cause: { code: 'proxy-password', status: 407 } }),
  ]) {
    expect(upstreamErrorCode(error)).toBe('UPSTREAM_REQUEST_FAILED');
  }
});
