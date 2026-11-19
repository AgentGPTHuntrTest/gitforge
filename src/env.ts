// The trial environment, as the harness hands it to the forge: the env's origin, the bearer token
// every API call presents, the seed every random choice must draw from, and the one now a response
// may carry. Nothing here reads a wall clock: two runs of the same trial must answer identically,
// so every timestamp the forge serves is derived from MAKEFUN_TRIAL_NOW, and every id it mints is
// either a content hash, a counter, or a seeded draw — never time, never Math.random.

import { createHash } from 'node:crypto';

/** The env's origin (MAKEFUN_ENV_URL): where the forge registers its port and polls for done. */
export const ENV_URL: string = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/**
 * The bearer token the suite presents (MAKEFUN_SHOP_TOKEN). An empty value means no token is
 * configured (a local run without one); then no request is refused for lacking it.
 */
export const TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The trial's seed (MAKEFUN_TRIAL_SEED): hex text; every random choice draws from it. */
export const TRIAL_SEED_HEX: string = process.env.MAKEFUN_TRIAL_SEED ?? '0'.repeat(64);

/**
 * The login the token names. The kit's scenario fixes the viewer for every trial of this contest
 * (sdk/conformance/wire.ts buildScenario().viewer.login); MAKEFUN_FORGE_LOGIN overrides it for a
 * local run, exactly as the house reference forge allows.
 */
export const FORGE_LOGIN: string = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';

/** The trial's opening time (MAKEFUN_TRIAL_NOW): RFC 3339 text or epoch milliseconds. */
const RAW_TRIAL_NOW: string = process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00.000Z';

/** The epoch milliseconds the trial's now names, resolved once at startup. */
const TRIAL_NOW_MS: number = (() => {
  const asNumber = Number(RAW_TRIAL_NOW);
  if (Number.isFinite(asNumber) && RAW_TRIAL_NOW.trim() !== '' && !RAW_TRIAL_NOW.includes('T')) {
    return asNumber;
  }
  const parsed = Date.parse(RAW_TRIAL_NOW);
  return Number.isFinite(parsed) ? parsed : Date.parse('2026-01-01T00:00:00.000Z');
})();

/** The trial's now as ISO text, the exact spelling every created_at/updated_at carries. */
export const NOW_ISO: string = new Date(TRIAL_NOW_MS).toISOString();

/** The trial's now in epoch seconds, for git authorship and commit headers. */
export const NOW_EPOCH_SEC: number = Math.floor(TRIAL_NOW_MS / 1000);

/** The timezone every commit the forge mints carries. */
export const NOW_TZ: string = '+0000';

/** A deterministic 32-hex id for anything that wants one, drawn from the trial seed in order. */
export function seededHex(label: string): string {
  // A stable digest: no state, no order dependence, safe to call from concurrent handlers.
  return createHash('sha256').update(`${TRIAL_SEED_HEX}:${label}`).digest('hex');
}

/** Whether a request's Authorization header presents the trial's token. */
export function tokenOk(authorization: string | undefined): boolean {
  if (TOKEN === '') return true;
  return authorization === `Bearer ${TOKEN}`;
}
