export function parseCSV(input) {
  if (typeof input !== "string" || input.length > 2_000_000)
    throw Error("Choose a CSV smaller than 2 MB.");
  const text = input.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw Error("Invalid CSV quotation.");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (c !== ",") {
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (closed && c.trim())
        throw Error("Unexpected text after quoted CSV field.");
      if (!closed) cell += c;
    }
  }
  if (quoted) throw Error("CSV has an unclosed quoted field.");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (rows.length < 2) throw Error("CSV needs a header and at least one row.");
  if (rows.length > 201)
    throw Error("Import up to 200 rows per batch in this first release.");
  if (rows[0].length > 60) throw Error("Too many columns.");
  return { headers: rows[0].map((v) => v.trim()), rows: rows.slice(1) };
}
export function decimal(value) {
  let s = String(value ?? "").trim();
  if (!s) return null;
  if (/^\(.+\)$/.test(s)) s = "-" + s.slice(1, -1);
  s = s.replace(/[£$€]/g, "").trim();
  if (s.includes(",") && !/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s))
    throw Error("Use a dot decimal separator.");
  s = s.replace(/,/g, "");
  if (!/^[+-]?\d{1,30}(\.\d{1,24})?$/.test(s)) throw Error("Invalid decimal.");
  const negative = s.startsWith("-");
  let [whole, fraction = ""] = s.replace(/^[+-]/, "").split(".");
  whole = whole.replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  return (
    (negative && (whole !== "0" || fraction) ? "-" : "") +
    whole +
    (fraction ? "." + fraction : "")
  );
}
export function isoDate(value) {
  const s = String(value ?? "").trim();
  let y,
    m,
    d,
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (match) [, y, m, d] = match;
  else {
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!match) return null;
    [, d, m, y] = match;
  }
  const date = new Date(Date.UTC(+y, +m - 1, +d));
  if (
    date.getUTCFullYear() !== +y ||
    date.getUTCMonth() !== +m - 1 ||
    date.getUTCDate() !== +d
  )
    return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}
export function classify(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  for (const [kind, re] of [
    ["buy", /^(buy|bought|purchase)\b/],
    ["sell", /^(sell|sold|sale)\b/],
    ["dividend", /^(dividend|distribution)\b/],
    ["interest", /^interest\b/],
    ["fee", /^(fee|charge)\b/],
    ["deposit", /^(deposit|contribution)\b/],
    ["withdrawal", /^withdrawal\b/],
    ["transfer", /^transfer\b/],
    [
      "corporate_action",
      /^(split|consolidation|merger|takeover|rights|return of capital|corporate action)\b/,
    ],
  ])
    if (re.test(s)) return kind;
  return "unclassified";
}
export async function sha256(s) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function normalizeCSV(csv, mapping, defaultCurrency = "GBP") {
  const parsed = parseCSV(csv);
  if (
    !mapping ||
    typeof mapping !== "object" ||
    !Number.isInteger(mapping.date) ||
    mapping.date < 0 ||
    mapping.date >= parsed.headers.length
  )
    throw Error("Map the transaction date.");
  for (const value of Object.values(mapping))
    if (
      value !== -1 &&
      (!Number.isInteger(value) || value < 0 || value >= parsed.headers.length)
    )
      throw Error("Invalid column mapping.");
  const normalized = [];
  for (let index = 0; index < parsed.rows.length; index++) {
    const row = parsed.rows[index],
      get = (key) =>
        mapping[key] >= 0 ? String(row[mapping[key]] ?? "").trim() : "";
    const errors = [],
      warnings = [],
      occurred_on = isoDate(get("date")),
      kind = classify(get("type"));
    if (!occurred_on) errors.push("Date must be DD/MM/YYYY or YYYY-MM-DD.");
    if (row.length !== parsed.headers.length)
      errors.push("Column count differs from header.");
    if (kind === "unclassified")
      warnings.push("Transaction type needs classification.");
    let amount = null,
      quantity = null;
    try {
      amount = decimal(get("amount"));
    } catch {
      errors.push("Invalid cash amount.");
    }
    try {
      quantity = decimal(get("quantity"));
    } catch {
      errors.push("Invalid quantity.");
    }
    const currency = (get("currency") || defaultCurrency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || currency === "GBX")
      errors.push("Cash currency must not be a pence quotation unit.");
    if (amount === null) warnings.push("Cash amount not provided.");
    if (["buy", "sell"].includes(kind) && !get("security"))
      warnings.push("Security identifier missing.");
    const core = {
      occurred_on,
      kind,
      description: get("description"),
      security: get("security"),
      quantity,
      amount,
      currency,
      reference: get("reference"),
    };
    normalized.push({
      ...core,
      row_number: index + 2,
      fingerprint: await sha256(JSON.stringify(core)),
      raw: { headers: parsed.headers, values: row },
      errors,
      warnings,
    });
  }
  return normalized;
}
