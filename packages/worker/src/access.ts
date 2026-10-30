/**
 * Cloudflare Access, checked again in the Worker.
 *
 * The Access application at the edge decides who reaches the hostname; this gate re-verifies
 * every request's Access JWT (signature, issuer, audience, time) before anything runs, so a way
 * around the edge (a misconfigured application, a hostname it does not cover) still lets
 * nothing through. Every check fails closed: bad configuration, a missing header, or a bad token
 * is a refusal.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com` */
  readonly issuer: string;
  /** The Access application's AUD tag. */
  readonly audience: string;
}

const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUDIENCE = /^[a-f0-9]{64}$/;

/** Null for anything that is not exactly a team domain and an AUD tag (placeholders, typos). */
export function parseAccessConfig(teamDomain: string | undefined, audience: string | undefined): AccessConfig | null {
  const domain = (teamDomain ?? "").trim().toLowerCase();
  const aud = (audience ?? "").trim().toLowerCase();
  return TEAM_DOMAIN.test(domain) && AUDIENCE.test(aud) ? { issuer: `https://${domain}`, audience: aud } : null;
}

export type Verifier = (token: string, now: Date) => Promise<JWTPayload | null>;

/** Verifies an Access JWT: RS256 only, issuer, audience, exp/nbf with 10 s of skew. */
export function createVerifier(config: AccessConfig, keys: JWTVerifyGetKey = remoteKeys(config)): Verifier {
  return async (token, now) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.audience,
        currentDate: now,
        clockTolerance: 10,
      });
      return payload;
    } catch {
      return null;
    }
  };
}

/** The team's signing keys, fetched and cached (rotations included) by jose. */
function remoteKeys(config: AccessConfig): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`));
}

const CLOUDFLARE_EMAIL = /^([a-z0-9]+(?:[.-][a-z0-9]+)*)@cloudflare\.com$/;

/**
 * The person a verified token names: the user part of a simple `@cloudflare.com` address, else
 * null. Service tokens (no email) are refused: every message in a session is someone's.
 */
export function personFromEmail(email: unknown): string | null {
  return typeof email === "string" ? (CLOUDFLARE_EMAIL.exec(email.trim().toLowerCase())?.[1] ?? null) : null;
}

export type Refusal = "access_not_configured" | "access_assertion_missing" | "access_assertion_invalid" | "not_a_person";

const STATUS: Readonly<Record<Refusal, number>> = {
  access_not_configured: 503,
  access_assertion_missing: 401,
  access_assertion_invalid: 401,
  not_a_person: 403,
};

export type GateDecision = { readonly allowed: true; readonly person: string } | { readonly allowed: false; readonly refusal: Refusal };

export async function checkAccess(request: Request, verify: Verifier | null, now: Date): Promise<GateDecision> {
  if (verify === null) return { allowed: false, refusal: "access_not_configured" };
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return { allowed: false, refusal: "access_assertion_missing" };
  const payload = await verify(assertion, now);
  if (payload === null) return { allowed: false, refusal: "access_assertion_invalid" };
  const person = personFromEmail(payload["email"]);
  if (person === null) return { allowed: false, refusal: "not_a_person" };
  return { allowed: true, person };
}

export function refusalResponse(refusal: Refusal): Response {
  return Response.json({ error: refusal }, { status: STATUS[refusal] });
}
