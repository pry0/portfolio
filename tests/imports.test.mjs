import test from "node:test";
import assert from "node:assert/strict";
import { parseCSV, decimal, isoDate, normalizeCSV } from "../src/imports.js";
const mapping = {
  date: 0,
  type: 1,
  security: 2,
  quantity: 3,
  amount: 4,
  currency: 5,
  description: 6,
  reference: 7,
};
test("CSV preserves quoted commas, escaped quotes, multiline text and BOM", () => {
  const parsed = parseCSV(
    '\uFEFFDate,Description,Amount\r\n16/11/2026,"Example, ""quoted""\nsecond line",1.23\r\n',
  );
  assert.deepEqual(parsed.rows, [
    ["16/11/2026", 'Example, "quoted"\nsecond line', "1.23"],
  ]);
  assert.throws(() => parseCSV('A,B\n"unfinished,1'), /unclosed/);
  assert.throws(() => parseCSV('A,B\n"x"broken,1'), /Unexpected/);
});
test("decimals retain financial precision without float conversion", () => {
  assert.equal(
    decimal("12345678901234567890.123456789012345678901234"),
    "12345678901234567890.123456789012345678901234",
  );
  assert.equal(decimal("(£1,234.5000)"), "-1234.5");
  assert.equal(decimal("-0.00"), "0");
  for (const bad of ["1,23", "1e9", "NaN", "Infinity", "0x10", "1.2.3"])
    assert.throws(() => decimal(bad));
});
test("UK dates and leap days are strict, with no rollover", () => {
  assert.equal(isoDate("04/03/2024"), "2024-03-04");
  assert.equal(isoDate("29/02/2024"), "2024-02-29");
  for (const bad of ["29/02/2023", "2026-13-01", "31/04/2026", "tomorrow"])
    assert.equal(isoDate(bad), null);
});
test("sales and duplicate rows remain, carrying exact quantities and original values", async () => {
  const csv =
    "Date,Type,ISIN,Quantity,Amount,Currency,Description,Reference\n01/01/2020,Buy,TEST,0.123456789012345678,100,GBP,Example,a\n02/01/2021,Sell,TEST,0.123456789012345678,150,GBP,Example,b\n02/01/2021,Sell,TEST,0.123456789012345678,150,GBP,Example,b";
  const rows = await normalizeCSV(csv, mapping);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].kind, "sell");
  assert.equal(rows[1].quantity, "0.123456789012345678");
  assert.equal(rows[1].fingerprint, rows[2].fingerprint);
  assert.equal(rows[1].raw.values[7], "b");
});
test("pence and malformed source rows are flagged rather than guessed", async () => {
  const rows = await normalizeCSV(
    "Date,Type,ISIN,Quantity,Amount,Currency,Description,Reference\n31/02/2026,Unknown,TEST,1,1.2,GBX,Example",
    mapping,
  );
  assert.equal(rows[0].kind, "unclassified");
  assert.equal(rows[0].errors.length, 3);
  await assert.rejects(() =>
    normalizeCSV("Date,Value\n01/01/2026,1", { date: -1 }),
  );
  assert.throws(
    () => parseCSV("A\n" + Array(201).fill("1").join("\n")),
    /200 rows/,
  );
});
