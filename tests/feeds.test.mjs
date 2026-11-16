import test from "node:test";
import assert from "node:assert/strict";
import { parseECB, refreshFeeds } from "../src/feeds.ts";
import { database } from "./database.mjs";
const xml =
  "<Cube time='2026-11-13'>" +
  [
    ["GBP", "0.88765"],
    ["USD", "1.04"],
    ["THB", "36.1"],
    ["PLN", "4.2"],
    ["JPY", "161.2"],
  ]
    .map(([c, r]) => `<Cube currency='${c}' rate='${r}'/>`)
    .join("") +
  "</Cube>";
test("FX keeps source publication date and exact decimal rate", () => {
  const parsed = parseECB(xml);
  assert.equal(parsed.date, "2026-11-13");
  assert.equal(parsed.rates[0].rate, "0.88765");
  assert.throws(() => parseECB("<Cube/>"));
});
test("feed observations persist and later provider failures keep prior data", async () => {
  const { DB, raw } = database(),
    original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) =>
      String(url).includes("ecb.europa.eu")
        ? new Response(xml)
        : Response.json({
            error: [],
            result: { pair: { c: ["123.456789012345678", "0"] } },
          });
    const first = await refreshFeeds({ DB });
    assert.equal(first.filter((r) => r.status === "ok").length, 5);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM prices").get().n, 4);
    assert.equal(
      raw
        .prepare("SELECT rate FROM exchange_rates WHERE quote_currency=?")
        .get("GBP").rate,
      "0.88765",
    );
    globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
    const second = await refreshFeeds({ DB });
    assert.equal(second.filter((r) => r.status === "error").length, 5);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM prices").get().n, 4);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM feed_runs").get().n, 10);
  } finally {
    globalThis.fetch = original;
    raw.close();
  }
});
