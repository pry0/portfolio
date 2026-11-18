// Public API contracts: https://portfolio.sharesight.com/api/{2,3}/doc/index.html
// Raw response bytes are the authoritative archive. This index stores numeric
// tokens as strings so quantities, exchange rates and source IDs are lossless.
export type Data = Record<string, unknown>;
export const object = (v: unknown): Data =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Data : {};
export const string = (v: unknown): string => typeof v === "string" ? v : "";
export const sourceId = (v: unknown): string | null => /^\d+$/.test(string(v)) ? string(v) : null;
export function exactJSON(raw: string): Data {
  JSON.parse(raw); // Validate before rewriting numeric tokens.
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^"\d-]+|./gs) ?? [];
  const value: unknown = JSON.parse(tokens.map(t => /^-?\d/.test(t) ? JSON.stringify(t) : t).join(""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Unexpected API response shape.");
  return value as Data;
}
export interface JobPlan { path: string; category: string; portfolioId: string | null }
export interface IndexedRecord {
  sourceKey: string; sourceId: string | null; kind: string; portfolioId: string | null;
  holdingId: string | null; occurredOn: string | null; label: string; sourceState: string | null; raw: Data;
}
export const LIMITATIONS = [
  "An API archive is not a reconciled investment ledger. Holdings, cost basis, returns and tax must be checked before replacing Sharesight.",
  "History is requested through the snapshot date. Later changes and future transactions require a new snapshot.",
  "UK tax-report PDFs, contract notes not exposed by the API, and any unavailable endpoints need separate exports.",
  "Licensed market-price and FX datasets are not assumed to be downloadable. Custom prices and transaction exchange rates are retained when returned.",
  "HL, Xero and other connection credentials cannot be transferred. They need their own connections in this app.",
  "Individual responses above 4 MB are flagged for a separate export; nothing is silently truncated.",
];
const V2 = "/api/v2/", V3 = "/api/v3/";
export function initialJobs(): JobPlan[] {
  return [
    [V2 + "portfolios.json", "portfolios"], [V3 + "portfolios?consolidated=true", "consolidated_views"],
    [V2 + "my_user.json", "account"], [V2 + "user_instruments.json", "instruments"],
    [V2 + "cash_accounts.json", "cash_accounts"], [V2 + "groups.json", "groups"],
    [V2 + "memberships.json", "memberships"], [V2 + "currencies.json", "currencies"],
    [V3 + "custom_investments", "custom_investments"],
  ].map(([path, category]) => ({path, category, portfolioId: null}));
}
// No arbitrary URL or method can be supplied by the browser or response links.
export function safePath(path: string): string {
  const u = new URL(path, "https://api.sharesight.com");
  if (u.origin !== "https://api.sharesight.com" || u.username || u.password || u.hash || path.length > 3000)
    throw Error("Unexpected source URL.");
  const routes = [
    /^\/api\/v2\/(portfolios|my_user|user_instruments|cash_accounts|groups|memberships|currencies)\.json$/,
    /^\/api\/v2\/portfolios\/\d+(?:\/(trades|payouts|valuation|performance))?\.json$/,
    /^\/api\/v2\/holdings\/\d+\/(trades|rejected_trades|payouts)\.json$/,
    /^\/api\/v2\/cash_accounts\/\d+\/cash_account_transactions\.json$/,
    /^\/api\/v2\/documents\/\d+\.json$/,
    /^\/api\/v3\/(portfolios|custom_investments)$/,
    /^\/api\/v3\/portfolios\/\d+\/(holdings|labels|user_setting|performance_index_chart)$/,
    /^\/api\/v3\/holdings\/\d+$/,
    /^\/api\/v3\/custom_investments\/\d+(?:\/(adjustments|coupon_rates))?$/,
    /^\/api\/v3\/custom_investment\/\d+\/prices\.json$/,
  ];
  if (!routes.some(r => r.test(u.pathname))) throw Error("Source endpoint is outside the read-only migration.");
  const keys = new Set(["consolidated", "start_date", "end_date", "balance_date", "include_sales", "grouping", "per_page", "page", "average_purchase_price", "cost_base", "values_over_time"]);
  for (const [key] of u.searchParams) if (!keys.has(key)) throw Error("Unexpected source parameter.");
  u.searchParams.sort();
  return u.pathname + u.search;
}
export async function inspectResponse(job: JobPlan, data: Data, asOf: string, digest: (s:string)=>Promise<string>) {
  const jobs: JobPlan[] = [], records: IndexedRecord[] = [], warnings: string[] = [];
  const add = (path: string, category: string, portfolioId = job.portfolioId) => jobs.push({path: safePath(path), category, portfolioId});
  const list = (key: string): Data[] => {
    if (!Array.isArray(data[key])) throw Error(`Expected ${key} array; response retained for review.`);
    return (data[key] as unknown[]).map(v => {
      const row = object(v);
      if (!Object.keys(row).length) throw Error(`Unexpected ${key} item; response retained for review.`);
      return row;
    });
  };
  const index = async (kind: string, r: Data, n: number, scope = "") => {
    const id = sourceId(r.id), portfolioId = sourceId(r.portfolio_id) || sourceId(object(r.portfolio).id) || (kind === "portfolio" ? id : job.portfolioId);
    const sourceKey = `${kind}:${portfolioId ?? "account"}:${scope}:${id ?? "anonymous:" + await digest(job.path + JSON.stringify(r)) + ":" + n}`;
    records.push({sourceKey, sourceId: id, kind, portfolioId, holdingId: sourceId(r.holding_id) || (kind === "holding" ? id : null),
      occurredOn: string(r.transaction_date || r.paid_on || r.date_time || r.lastTradedOn || r.date || r.goes_ex_on) || null,
      label: string(r.symbol || r.code || r.name || r.description || r.transaction_type || object(r.instrument).name) || kind,
      sourceState: string(r.state) || null, raw:r});
  };
  const documents = (r:Data) => {
    if (sourceId(r.attachment_id)) add(V2 + `documents/${r.attachment_id}.json`, "document");
    for (const key of ["documents", "attachments"]) if (Array.isArray(r[key])) for (const doc of r[key] as unknown[]) {
      const d = object(doc), id = sourceId(d.id);
      // Only document attachment types are downloadable through Show Document.
      if (id && (!d.type || /document/i.test(string(d.type)))) add(V2 + `documents/${id}.json`, "document");
      else if (id) warnings.push("A non-document attachment needs a manual export.");
    }
  };
  const holding = (id: string | null, portfolioId: string | null) => {
    if (!id) return;
    add(V3 + `holdings/${id}?average_purchase_price=true&cost_base=true&values_over_time=true`, "holding", portfolioId);
    add(V2 + `holdings/${id}/rejected_trades.json`, "rejected_trades", portfolioId);
  };
  const category = job.category;
  if (category === "portfolios" || category === "consolidated_views") {
    for (const [n,p] of list("portfolios").entries()) {
      const id = sourceId(p.id);
      if (!id) throw Error("Portfolio without a source ID.");
      await index(category === "portfolios" ? "portfolio" : "consolidated_view", p, n);
      if (category === "consolidated_views") {
        add(V3 + `portfolios/${id}/user_setting?consolidated=true`, "settings", id);
        continue;
      }
      add(V2 + `portfolios/${id}.json`, "portfolio", id);
      add(V2 + `portfolios/${id}/trades.json?end_date=${asOf}`, "trades", id);
      add(V2 + `portfolios/${id}/payouts.json?start_date=1900-01-01&end_date=${asOf}`, "payouts", id);
      add(V2 + `portfolios/${id}/valuation.json?balance_date=${asOf}&include_sales=true&grouping=ungrouped`, "valuation", id);
      add(V2 + `portfolios/${id}/performance.json?end_date=${asOf}&include_sales=true&grouping=ungrouped`, "performance", id);
      add(V3 + `portfolios/${id}/holdings`, "holdings", id);
      add(V3 + `portfolios/${id}/labels`, "labels", id);
      add(V3 + `portfolios/${id}/user_setting`, "settings", id);
      add(V3 + `portfolios/${id}/performance_index_chart?end_date=${asOf}&grouping=ungrouped`, "performance_chart", id);
    }
  } else if (category === "cash_accounts") {
    for (const [n,r] of list("cash_accounts").entries()) {
      await index("cash_account",r,n);
      const id = sourceId(r.id);
      if (!id) throw Error("Cash account without a source ID.");
      add(V2 + `cash_accounts/${id}/cash_account_transactions.json`, "cash_transactions", sourceId(r.portfolio_id));
    }
  } else if (["trades","rejected_trades","payouts","cash_transactions"].includes(category)) {
    const field = category === "cash_transactions" ? "cash_account_transactions" : category === "rejected_trades" ? (Array.isArray(data.rejected_trades) ? "rejected_trades" : "trades") : category;
    const scope = category === "cash_transactions" ? /cash_accounts\/(\d+)/.exec(job.path)?.[1] ?? "" : "";
    for (const [n,r] of list(field).entries()) {
      await index(category === "payouts" ? "payout" : category === "cash_transactions" ? "cash_transaction" : "trade", r, n, scope);
      holding(sourceId(r.holding_id), sourceId(r.portfolio_id) || job.portfolioId);
      documents(r);
    }
  } else if (category === "holdings" || category === "valuation" || category === "performance") {
    for (const [n,r] of list("holdings").entries()) {
      if (category === "holdings") await index("holding_summary",r,n);
      holding(sourceId(r.id), sourceId(object(r.portfolio).id) || job.portfolioId);
      documents(r);
    }
  } else if (category === "holding") {
    const r = object(data.holding);
    if (!sourceId(r.id)) throw Error("Holding details missing; response retained.");
    await index("holding", r, 0); documents(r);
  } else if (category === "custom_investments") {
    for (const [n,r] of list("custom_investments").entries()) {
      await index("custom_investment",r,n);
      const id = sourceId(r.id), p = sourceId(object(r.portfolio).id) || sourceId(r.portfolio_id);
      if (!id) throw Error("Custom investment without a source ID.");
      add(V3 + `custom_investments/${id}`, "custom_investment",p);
      add(V3 + `custom_investment/${id}/prices.json?per_page=100&end_date=${asOf}`, "custom_prices",p);
      add(V3 + `custom_investments/${id}/${/bond|fixed/i.test(string(r.investment_type)) ? "coupon_rates" : "adjustments"}?per_page=100&end_date=${asOf}`, /bond|fixed/i.test(string(r.investment_type)) ? "coupon_rates" : "adjustments",p);
    }
  } else if (["custom_prices","adjustments","coupon_rates"].includes(category)) {
    const key = category === "custom_prices" ? "prices" : category;
    const scope = /custom_investments?\/(\d+)/.exec(job.path)?.[1] ?? "";
    for (const [n,r] of list(key).entries()) await index(category === "custom_prices" ? "custom_price" : category === "adjustments" ? "custom_adjustment" : "coupon_rate",r,n,scope);
  } else if (["instruments","groups","memberships","labels"].includes(category)) {
    for (const [n,r] of list(category).entries()) await index(category.slice(0,-1),r,n);
  } else {
    const r = category === "custom_investment" ? object(data.custom_investment ?? data) : data;
    await index(category,r,0);
  }
  const cursor = object(data.pagination).page;
  const nextLink = object(data.links).next;
  if (cursor !== null && cursor !== undefined && cursor !== "") {
    if (typeof cursor !== "string") throw Error("Unexpected pagination cursor.");
    const next = new URL(job.path,"https://api.sharesight.com");
    if (next.searchParams.get("page") === cursor) throw Error("Repeated pagination cursor; export requires review.");
    next.searchParams.set("page",cursor);
    add(next.pathname + next.search,category);
  } else if (nextLink) {
    const path = safePath(string(nextLink)), current = new URL(job.path,"https://api.sharesight.com");
    if (new URL(path,"https://api.sharesight.com").pathname !== current.pathname || path === safePath(job.path)) throw Error("Unexpected pagination link.");
    add(path,category);
  }
  return {jobs, records, warnings};
}
