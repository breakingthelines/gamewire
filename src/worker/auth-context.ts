/**
 * btl-auth-context verification glue for gamewire-worker.
 *
 * Bridges the `@breakingthelines/auth-sdk` server-side Verifier into the
 * worker's HTTP gate. kernel-service mints a signed Ed25519 token via
 * `authcontext.Minter` for every `/workflows/*` call and the worker
 * verifies it here. This module owns three concerns:
 *
 *   1. Boot-time JWKS fetch: `createAuthContextVerifier` does a single
 *      JWKS fetch when the worker starts. The resulting `Verifier`
 *      instance holds a parsed `KeyObject` and is safe to reuse across
 *      requests — we never refetch JWKS per request. If the JWKS URL is
 *      unreachable, boot fails — there is no fallback credential.
 *
 *   2. Header-level claims check: `verifyAuthContextHeader` runs the
 *      cryptographic verification, then layers BTL-specific authorisation
 *      checks on top (SERVICE subject, expected audience, required
 *      scope). It returns a discriminated result instead of throwing so
 *      the HTTP layer can log a verbose 401 reason without unwinding the
 *      stack.
 *
 *   3. Defensive failure mode: every error path returns a short reason
 *      string. The HTTP handler logs the reason and surfaces a generic
 *      `bad_auth_context` to clients to avoid oracle-leaking which
 *      specific claim failed.
 */

import {
  AUTH_CONTEXT_HEADER,
  Verifier,
  type VerifiedAuthContext,
} from '@breakingthelines/auth-sdk/server';

import type { GamewireWorkerConfig } from './config.js';

/**
 * Downstream header injected by auth-service ext_authz when it inline-mints
 * a service-principal `btl-auth-context` for a SPIFFE mesh caller (see
 * auth-service `extauthz_mesh.go::downstreamAuthContextHeader`). Mesh
 * consumers must read this header — user-flow consumers read
 * {@link AUTH_CONTEXT_HEADER}. gamewire-worker is mesh-only, so prefer
 * this header and fall back to {@link AUTH_CONTEXT_HEADER} for
 * defence-in-depth (e.g. legacy callers that still mint client-side).
 */
export const MESH_AUTH_CONTEXT_HEADER = 'x-btl-auth-context' as const;

export { AUTH_CONTEXT_HEADER, Verifier };
export type { VerifiedAuthContext };

/**
 * Construct a {@link Verifier} for inbound `btl-auth-context` tokens.
 *
 * Performs exactly one JWKS fetch at boot. The returned instance is
 * cached by the caller (typically `server.ts` module scope) so every
 * request reuses the same parsed public key. Rejects when the JWKS URL
 * is unreachable or malformed — boot is expected to fail in that case
 * since there is no fallback credential.
 */
export const createAuthContextVerifier = async (cfg: GamewireWorkerConfig): Promise<Verifier> =>
  Verifier.fromJWKSURL(cfg.authContextJwksUrl, { issuer: cfg.authContextIssuer });

/**
 * Outcome of a `btl-auth-context` header verification.
 *
 * Either a verified context with the parsed claims, or an `error`
 * reason that the HTTP layer logs but does not echo to the client.
 */
export type AuthContextVerifyResult =
  | { ok: true; context: VerifiedAuthContext }
  | { ok: false; error: string };

const ok = (context: VerifiedAuthContext): AuthContextVerifyResult => ({ ok: true, context });
const err = (error: string): AuthContextVerifyResult => ({ ok: false, error });

/**
 * Verify a raw `btl-auth-context` header value against the configured
 * verifier, then check the BTL-specific service-principal authorisation
 * claims (SUBJECT_TYPE_SERVICE, expected audience, required scope).
 *
 * Never throws — every failure mode returns a `{ ok: false, error }`
 * with a short reason so the caller can log it. Pass `now` to override
 * the clock for deterministic tests.
 */
export const verifyAuthContextHeader = (
  verifier: Verifier,
  headerValue: string | undefined,
  requiredAudience: string,
  requiredScope: string,
  now?: Date
): AuthContextVerifyResult => {
  if (headerValue === undefined || headerValue.trim() === '') {
    return err('missing_header');
  }

  let context: VerifiedAuthContext;
  try {
    context = verifier.verify(headerValue.trim(), { now });
  } catch (verifyErr) {
    return err(
      `verify_failed:${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`
    );
  }

  if (context.subjectType !== 'SERVICE') {
    return err(`wrong_subject_type:${context.subjectType}`);
  }

  const principal = context.servicePrincipal;
  if (!principal) {
    return err('missing_service_principal');
  }

  if (principal.audience !== requiredAudience) {
    return err(`wrong_audience:${principal.audience ?? '<unset>'}`);
  }

  const scopes = principal.grantedScopes ?? [];
  if (!scopes.includes(requiredScope)) {
    return err(`missing_required_scope:${requiredScope}`);
  }

  return ok(context);
};
