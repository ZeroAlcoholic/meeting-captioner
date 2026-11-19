/**
 * The one seam between the browser and "the service that mints session
 * credentials". Server-backed builds talk to services/online over the network.
 * The serverless phone build installs an in-browser broker instead (see
 * src/mobile/device-broker.ts), so providers stay unaware of where a token
 * comes from.
 *
 * The default resolves the global `fetch` at call time, so tests that stub it
 * keep working.
 */
type Fetch = typeof fetch;

let installed: Fetch | null = null;

export const serviceFetch: Fetch = (input, init) => (installed ?? fetch)(input, init);

/** Pass null to restore the network default. */
export function installServiceFetch(next: Fetch | null): void {
  installed = next;
}
