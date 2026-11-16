import test from "node:test";
import assert from "node:assert/strict";
import { authorize } from "../src/auth.ts";
const env = {
  ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
  ACCESS_AUD: "test-audience",
  OWNER_EMAIL: "owner@example.test",
  LOCAL_DEVELOPMENT: "false",
};
const keys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
  kid: "key-1",
};
const base64 = (v) => Buffer.from(v).toString("base64url");
async function token(overrides = {}) {
  const h = base64(JSON.stringify({ alg: "RS256", kid: "key-1" }));
  const p = base64(
    JSON.stringify({
      iss: "https://test.cloudflareaccess.com",
      aud: ["test-audience"],
      email: "owner@example.test",
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${base64(signature)}`;
}
const fetchKeys = async (url) => {
  assert.equal(url, "https://test.cloudflareaccess.com/cdn-cgi/access/certs");
  return Response.json({ keys: [jwk] });
};
const req = (t) =>
  new Request("https://portfolio.example.test/api/state", {
    headers: t ? { "Cf-Access-Jwt-Assertion": t } : {},
  });
test("valid signed owner assertion is accepted", async () =>
  assert.equal(
    await authorize(req(await token()), env, fetchKeys),
    "owner@example.test",
  ));
test("wrong audience, issuer, owner and expired or future claims fail closed", async () => {
  for (const claims of [
    { aud: ["elsewhere"] },
    { iss: "https://evil.example.test" },
    { email: "stranger@example.test" },
    { exp: 0 },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
  ])
    assert.equal(
      await authorize(req(await token(claims)), env, fetchKeys),
      null,
    );
});
test("tampering, missing configuration and unavailable signing keys fail closed", async () => {
  const original = await token();
  const parts = original.split(".");
  parts[1] = base64(
    JSON.stringify({
      iss: "https://test.cloudflareaccess.com",
      aud: ["test-audience"],
      email: "owner@example.test",
      exp: 9999999999,
    }),
  );
  assert.equal(await authorize(req(parts.join(".")), env, fetchKeys), null);
  assert.equal(
    await authorize(req(original), { ...env, ACCESS_AUD: "" }, fetchKeys),
    null,
  );
  assert.equal(
    await authorize(req(original), env, async () => {
      throw Error("offline");
    }),
    null,
  );
  assert.equal(await authorize(req(), env, fetchKeys), null);
});
test("local bypass requires explicit development mode and loopback HTTP", async () => {
  assert.equal(
    await authorize(new Request("http://localhost/api/state"), env),
    null,
  );
  assert.equal(
    await authorize(new Request("http://localhost/api/state"), {
      ...env,
      LOCAL_DEVELOPMENT: "true",
    }),
    "local-development",
  );
  assert.equal(
    await authorize(new Request("https://localhost/api/state"), {
      ...env,
      LOCAL_DEVELOPMENT: "true",
    }),
    null,
  );
  assert.equal(
    await authorize(req(), { ...env, LOCAL_DEVELOPMENT: "true" }),
    null,
  );
});
