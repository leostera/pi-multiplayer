import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkAccess, createVerifier, parseAccessConfig, personFromEmail } from "../src/access.ts";

const TEAM = "team.cloudflareaccess.com";
const AUD = "a".repeat(64);

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const config = parseAccessConfig(TEAM, AUD)!;
  const verify = createVerifier(config, createLocalJWKSet({ keys: [jwk] }));
  const sign = (claims: Record<string, unknown>, { issuer = `https://${TEAM}`, audience = AUD, expires = "5m" } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(privateKey);
  const request = (token?: string) => new Request("https://host/s/x", { headers: token ? { "cf-access-jwt-assertion": token } : {} });
  return { verify, sign, request };
}

test("a person with a verified Access token gets in, named by their email", async () => {
  const { verify, sign, request } = await setup();
  assert.deepEqual(await checkAccess(request(await sign({ email: "Leo.Ostera@cloudflare.com" })), verify, new Date()), { allowed: true, person: "leo.ostera" });
});

test("everything else is refused", async () => {
  const { verify, sign, request } = await setup();
  const refusal = async (req: Request, v = verify) => {
    const decision = await checkAccess(req, v, new Date());
    return decision.allowed ? "allowed" : decision.refusal;
  };
  assert.equal(await refusal(request(), null), "access_not_configured");
  assert.equal(await refusal(request()), "access_assertion_missing");
  assert.equal(await refusal(request("not.a.jwt")), "access_assertion_invalid");
  assert.equal(await refusal(request(await sign({ email: "leo@cloudflare.com" }, { audience: "b".repeat(64) }))), "access_assertion_invalid");
  assert.equal(await refusal(request(await sign({ email: "leo@cloudflare.com" }, { issuer: "https://other.cloudflareaccess.com" }))), "access_assertion_invalid");
  assert.equal(await refusal(request(await sign({ email: "leo@cloudflare.com" }, { expires: "-1m" }))), "access_assertion_invalid");
  assert.equal(await refusal(request(await sign({ common_name: "service-token" }))), "not_a_person");
  assert.equal(await refusal(request(await sign({ email: "leo@example.com" }))), "not_a_person");
});

test("configuration must be exactly a team domain and an AUD tag", () => {
  assert.equal(parseAccessConfig("", AUD), null);
  assert.equal(parseAccessConfig("https://team.cloudflareaccess.com", AUD), null);
  assert.equal(parseAccessConfig(TEAM, "xyz"), null);
  assert.equal(personFromEmail("a+b@cloudflare.com"), null);
});
