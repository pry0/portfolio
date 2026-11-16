type Config = Pick<
  Env,
  "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "OWNER_EMAIL" | "LOCAL_DEVELOPMENT"
>;
type Claims = {
  iss?: string;
  aud?: string[];
  exp?: number;
  nbf?: number;
  email?: string;
};
type Key = JsonWebKey & { kid?: string };
const decode = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
export async function authorize(
  request: Request,
  env: Config,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const url = new URL(request.url);
  if (
    env.LOCAL_DEVELOPMENT === "true" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return "local-development";
  const team = env.ACCESS_TEAM_DOMAIN;
  if (
    !team ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) ||
    !env.ACCESS_AUD ||
    !env.OWNER_EMAIL
  )
    return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 16384) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as {
      alg?: string;
      kid?: string;
    };
    const claims = JSON.parse(
      new TextDecoder().decode(decode(parts[1])),
    ) as Claims;
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== "RS256" ||
      !header.kid ||
      claims.iss !== `https://${team}` ||
      !Array.isArray(claims.aud) ||
      !claims.aud.includes(env.ACCESS_AUD) ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      (typeof claims.nbf === "number" && claims.nbf > now) ||
      typeof claims.email !== "string" ||
      claims.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()
    )
      return null;
    const response = await fetcher(`https://${team}/cdn-cgi/access/certs`, {
      cf: { cacheEverything: true, cacheTtl: 300 },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const { keys } = await response.json<{ keys: Key[] }>();
    const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return (await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ))
      ? claims.email
      : null;
  } catch {
    return null;
  }
}
