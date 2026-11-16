import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api.ts";
import { database } from "./database.mjs";
const origin = "https://portfolio.example.test";
const call = (env, path, data, extra = {}) =>
  api(
    new Request(
      origin + path,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
              ...extra,
            },
            body: JSON.stringify(data),
          },
    ),
    env,
  );
async function setup() {
  const db = database(),
    env = { DB: db.DB };
  const response = await call(env, "/api/portfolios", {
    name: "Test account",
    kind: "isa",
    currency: "GBP",
  });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  return { ...db, env, id };
}
const csv =
  'Date,Type,ISIN,Quantity,Amount,Currency,Details\r\n01/01/2020,Buy,TEST,0.123456789012345678,100,GBP,"Original 🪙, note"\r\n02/01/2021,Sell,TEST,0.123456789012345678,150,GBP,Sold entirely\r\n';
const mapping = {
  date: 0,
  type: 1,
  security: 2,
  quantity: 3,
  amount: 4,
  currency: 5,
  description: 6,
};
const payload = (id) => ({
  portfolioId: id,
  source: "hl",
  filename: "test.csv",
  csv,
  mapping,
});
test("preview writes nothing; archive preserves sold records and exact original", async () => {
  const { env, id, raw } = await setup();
  const p = await call(env, "/api/imports/preview", payload(id));
  assert.equal(p.status, 200);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM imports").get().n, 0);
  const r = await call(env, "/api/imports", payload(id));
  assert.equal(r.status, 201);
  const imported = await r.json();
  assert.equal(
    await (await call(env, `/api/imports/${imported.id}/file`)).text(),
    csv,
  );
  const rows = raw.prepare("SELECT * FROM entries ORDER BY row_number").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, "sell");
  assert.equal(rows[1].status, "review");
  assert.equal(rows[1].quantity, "0.123456789012345678");
  const backup = await (await call(env, "/api/export")).json();
  assert.equal(backup.entries.length, 2);
  assert.equal(backup.audit_log.length, 2);
  raw.close();
});
test("exact reimport is rejected; overlapping source rows are flagged but retained", async () => {
  const { env, id, raw } = await setup();
  assert.equal((await call(env, "/api/imports", payload(id))).status, 201);
  assert.equal((await call(env, "/api/imports", payload(id))).status, 409);
  const next = await call(env, "/api/imports", {
    ...payload(id),
    csv: csv + "03/01/2021,Dividend,TEST,,2,GBP,Income\r\n",
  });
  assert.equal(next.status, 201);
  const rows = raw.prepare("SELECT * FROM entries").all();
  assert.equal(rows.length, 5);
  assert.equal(
    rows.filter((r) =>
      JSON.parse(r.warnings_json).some((w) => w.includes("duplicate")),
    ).length,
    2,
  );
  raw.close();
});
test("CSRF and invalid acceptance fail; ignored records remain in archive", async () => {
  const { env, id, raw } = await setup();
  assert.equal(
    (
      await call(
        env,
        "/api/features",
        { id: "A01", choice: "now" },
        { Origin: "https://evil.example.test" },
      )
    ).status,
    403,
  );
  await call(env, "/api/imports", {
    ...payload(id),
    csv: "Date,Type,ISIN,Quantity,Amount,Currency,Details\n31/02/2026,Other,TEST,1,100,GBP,Bad date",
  });
  const row = raw.prepare("SELECT * FROM entries").get();
  assert.equal(
    (
      await call(env, `/api/entries/${row.id}/status`, {
        status: "accepted",
        kind: "buy",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(env, `/api/entries/${row.id}/status`, {
        status: "ignored",
        kind: "buy",
      })
    ).status,
    200,
  );
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entries").get().n, 1);
  raw.close();
});
test("corporate events record evidence without modifying transactions", async () => {
  const { env, id, raw } = await setup();
  assert.equal(
    (
      await call(env, "/api/actions", {
        portfolioId: id,
        date: "2026-11-16",
        kind: "split",
        security: "TEST",
        notes: "2 for 1; notice reference TEST-1",
      })
    ).status,
    201,
  );
  assert.equal(
    raw.prepare("SELECT COUNT(*) n FROM corporate_actions").get().n,
    1,
  );
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM entries").get().n, 0);
  raw.close();
});
test("chunk boundaries preserve Unicode originals and database batch rolls back on failure", async () => {
  const { env, id, raw } = await setup();
  const long =
    "Date,Type,ISIN,Quantity,Amount,Currency,Details\n01/01/2026,Buy,TEST,1,10,GBP," +
    "x".repeat(31920) +
    "🪙".repeat(500);
  const r = await call(env, "/api/imports", { ...payload(id), csv: long });
  assert.equal(r.status, 201);
  const imported = await r.json();
  assert.equal(
    await (await call(env, `/api/imports/${imported.id}/file`)).text(),
    long,
  );
  raw.exec(
    "CREATE TRIGGER reject_entry BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
  );
  assert.equal((await call(env, "/api/imports", payload(id))).status, 500);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM imports").get().n, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM audit_log").get().n, 2);
  raw.close();
});
