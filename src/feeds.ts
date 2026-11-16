import { decimal } from "./imports.js";
async function readText(response: Response, max = 100000) {
  if (!response.ok) throw Error("Provider unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw Error("Empty response");
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw Error("Response too large");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}
export function parseECB(xml: string) {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) throw Error("Missing publication date");
  const rates = [
    ...xml.matchAll(
      /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g,
    ),
  ].map((m) => ({ currency: m[1], rate: decimal(m[2])! }));
  if (
    rates.length < 5 ||
    rates.length > 100 ||
    !rates.some((r) => r.currency === "GBP") ||
    rates.some((r) => !r.rate || r.rate === "0")
  )
    throw Error("Incomplete rates");
  return { date, rates };
}
export async function refreshFeeds(env: Env) {
  const results: { provider: string; status: string; count: number }[] = [];
  const now = new Date().toISOString();
  for (const [instrument, pair] of [
    ["BTC", "XBTUSD"],
    ["ETH", "ETHUSD"],
    ["LINK", "LINKUSD"],
    ["XMR", "XMRUSD"],
  ]) {
    try {
      const r = await fetch(
        `https://api.kraken.com/0/public/Ticker?pair=${pair}`,
        { signal: AbortSignal.timeout(8000) },
      );
      const data = JSON.parse(await readText(r)) as {
        error: string[];
        result: Record<string, { c: string[] }>;
      };
      if (data.error.length) throw Error("Pair unavailable");
      const price = decimal(Object.values(data.result)[0]?.c?.[0]);
      if (!price || price === "0" || price.startsWith("-"))
        throw Error("Invalid price");
      await env.DB.prepare("INSERT INTO prices VALUES(?,?,?,?,?)")
        .bind(instrument, "USD", price, now, "Kraken last trade (observed)")
        .run();
      results.push({
        provider: `Kraken:${instrument}`,
        status: "ok",
        count: 1,
      });
    } catch {
      results.push({
        provider: `Kraken:${instrument}`,
        status: "error",
        count: 0,
      });
    }
  }
  try {
    const r = await fetch(
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
      { signal: AbortSignal.timeout(8000) },
    );
    const { date, rates } = parseECB(await readText(r));
    await env.DB.batch(
      rates.map((v) =>
        env.DB.prepare(
          "INSERT INTO exchange_rates VALUES(?,?,?,?,?,?) ON CONFLICT(base_currency,quote_currency,effective_date,source) DO UPDATE SET rate=excluded.rate,fetched_at=excluded.fetched_at",
        ).bind("EUR", v.currency, v.rate, date, "ECB reference", now),
      ),
    );
    results.push({ provider: "ECB", status: "ok", count: rates.length });
  } catch {
    results.push({ provider: "ECB", status: "error", count: 0 });
  }
  await env.DB.batch(
    results.map((r) =>
      env.DB.prepare("INSERT INTO feed_runs VALUES(?,?,?,?,?,?)").bind(
        crypto.randomUUID(),
        r.provider,
        r.status,
        r.count,
        r.status === "error"
          ? "Refresh failed; previous observations retained."
          : null,
        now,
      ),
    ),
  );
  return results;
}
