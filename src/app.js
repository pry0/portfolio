import { parseCSV } from "./imports.js";
import { groups } from "./features.js";
const $ = (s) => document.querySelector(s),
  e = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  pretty = (v) =>
    String(v)
      .replaceAll("_", " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
  date = (v) =>
    v
      ? new Date(v).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "Date missing";
let state = {
    portfolios: [],
    imports: [],
    entryCount: 0,
    reviewCount: 0,
    actions: [],
    choices: [],
    feedRuns: [],
    prices: [],
    fx: [],
    entries: [],
  },
  signedIn = false,
  view = "overview",
  importFile = null,
  preview = null,
  handler = null,
  timer;
const title = {
  overview: [
    "THE COMPLETE PICTURE",
    "Your investments.<br><em>All accounted for.</em>",
    "A clear home for your assets, income and investment history.",
  ],
  activity: [
    "NOTHING LEFT BEHIND",
    "Your complete<br><em>investment history.</em>",
    "Purchases, sales and income stay in the archive, even after an asset is sold.",
  ],
  actions: [
    "EVERY CHANGE, RECORDED",
    "Corporate actions.<br><em>With the details intact.</em>",
    "Keep the event, effective date and supporting explanation together.",
  ],
  imports: [
    "BRING YOUR HISTORY HOME",
    "A fresh start.<br><em>Without losing the past.</em>",
    "Import, inspect and confirm. Original source files stay attached.",
  ],
  feeds: [
    "THE RIGHT SOURCES",
    "Connected where<br><em>it counts.</em>",
    "Clear sources, dated prices and an honest view of each connection.",
  ],
  features: [
    "BUILT AROUND YOU",
    "Your portfolio.<br><em>Your priorities.</em>",
    "Choose what you need now, what can wait and what to leave out.",
  ],
};
const names = {
  overview: "Overview",
  activity: "Transaction archive",
  actions: "Corporate actions",
  imports: "Import centre",
  feeds: "Prices & connections",
  features: "Feature planner",
};
function toast(m) {
  $("#toast").textContent = m;
  $("#toast").classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => $("#toast").classList.remove("show"), 5000);
}
async function request(path, data) {
  const r = await fetch(
    path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  let result;
  try {
    result = await r.json();
  } catch {
    throw Error("Your session may have expired. Refresh this page to sign in.");
  }
  if (!r.ok) throw Error(result.error || "Request failed.");
  return result;
}
async function refresh() {
  try {
    state = await request("/api/state");
    signedIn = true;
    $("#auth-banner").hidden = true;
    $("#connection").textContent = "Private workspace";
  } catch (error) {
    signedIn = false;
    $("#auth-banner").hidden = false;
    $("#auth-banner").textContent = error.message;
    $("#connection").textContent = "Sign-in required";
  }
  $("#review-count").textContent = state.reviewCount;
  render();
}
function authenticated() {
  if (signedIn) return true;
  toast("Sign in before saving records.");
  return false;
}
function go(v) {
  if (!title[v]) return;
  view = v;
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function empty(t, p, action = "") {
  return `<div class="empty"><div class="empty-symbol">◇</div><h3>${t}</h3><p>${p}</p>${action}</div>`;
}
function accountName(id) {
  return state.portfolios.find((p) => p.id === id)?.name || "Account";
}
const importButton =
  '<button class="button small" data-view="imports">Import records ↗</button>';
function accounts() {
  return state.portfolios.length
    ? state.portfolios
        .map(
          (p) =>
            `<div class="account"><span class="account-symbol">${e(p.name.slice(0, 1))}</span><div><h3>${e(p.name)}</h3><small>${e(pretty(p.kind))} · ${e(p.currency)}</small></div><span class="pill gray">${state.imports.filter((i) => i.portfolio_id === p.id).length} imports</span></div>`,
        )
        .join("")
    : empty(
        "Start with your first account",
        "Keep personal, company and family records separate from the beginning.",
        '<button class="button small" data-action="account">＋ Add account</button>',
      );
}
function overview() {
  return `<section class="stats" aria-label="Archive overview">${[
    ["Accounts", state.portfolios.length, "Separate ownership & wrappers"],
    ["Records archived", state.entryCount, "Including historical sales"],
    ["Awaiting review", state.reviewCount, "Check before accepting"],
    ["Corporate events", state.actions.length, "Evidence, dates & decisions"],
  ]
    .map(
      ([label, value, hint]) =>
        `<div class="stat"><label>${label}</label><strong>${value.toLocaleString("en-GB")}</strong><small>${hint}</small></div>`,
    )
    .join(
      "",
    )}</section><div class="layout"><div><section class="intro"><span class="number">01 / YOUR STARTING POINT</span><div class="art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><h2>Bring your history.<br>Build a better picture.</h2><p>Start with your existing records. A sale closes a position, not its history.</p><button class="button primary" data-view="imports">Open import centre ↗</button></section><section class="panel"><div class="panel-head"><h2>Your accounts</h2><button class="button ghost small" data-action="account">＋ Add account</button></div>${accounts()}</section></div><div><section class="panel"><div class="panel-head"><h2>A considered beginning</h2><span class="pill">GETTING STARTED</span></div><div class="steps"><div class="step"><span class="step-n">01</span><div><h3>Separate your accounts</h3><p>Give each owner and wrapper a clear home.</p></div><button class="button ghost small" data-action="account">Add ↗</button></div><div class="step"><span class="step-n">02</span><div><h3>Recover your history</h3><p>Bring across buys, sells, income and fees.</p></div><button class="button ghost small" data-view="imports">Import ↗</button></div><div class="step"><span class="step-n">03</span><div><h3>Check the evidence</h3><p>Resolve mismatches and possible duplicates.</p></div><button class="button ghost small" data-view="activity">Review ↗</button></div></div></section><section class="panel"><div class="panel-head"><h2>Make it your own</h2><span class="pill gray">78 features</span></div><div class="panel-body"><h3>Keep what matters to you.</h3><p>Shape the next release around your own investments and the way you work.</p><button class="button small" data-view="features">Choose your features ↗</button></div></section></div></div>`;
}
function entryTable(rows) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>DATE / ACCOUNT</th><th>RECORD</th><th>QUANTITY</th><th>CASH AMOUNT</th><th>REVIEW</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="number-cell">${e(date(r.occurred_on))}<span class="subtext">${e(accountName(r.portfolio_id))}</span></td><td class="row-title"><strong>${e(r.security || r.description || pretty(r.kind))}</strong><span class="subtext">${e(pretty(r.kind))}</span><span class="subtext">${e([...JSON.parse(r.errors_json), ...JSON.parse(r.warnings_json)].join(" "))}</span></td><td class="number-cell">${e(r.quantity ?? "—")}</td><td class="number-cell">${e(r.amount ?? "—")}<span class="subtext">${e(r.currency)}</span></td><td><button class="button small" data-review="${e(r.id)}">${e(pretty(r.status))} ↗</button></td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "Your history will appear here",
        "Import a statement to see purchases, sales, income and fees in one searchable archive.",
        importButton,
      );
}
function activity() {
  return `<div class="controls"><input id="search" type="search" aria-label="Search transactions" placeholder="Search security, description or account…"><select id="status" aria-label="Review status"><option value="all">All records</option><option value="review">Awaiting review</option><option value="accepted">Accepted</option><option value="ignored">Ignored</option></select><button class="button" data-action="export">↓ Export records</button></div><section class="panel"><div class="panel-head"><h2>Transaction archive</h2><small>Latest 100 records · all history retained</small></div><div id="entry-results">${entryTable(state.entries)}</div></section><p class="fine">Amounts retain their original currencies. Acceptance confirms a source record; it does not calculate holdings, investment returns or tax.</p>`;
}
function actions() {
  return `<div class="controls"><button class="button primary" data-action="corporate">＋ Record an event</button></div><section class="panel"><div class="panel-head"><h2>Corporate-action register</h2><span class="pill gray">${state.actions.length} recent records</span></div>${state.actions.length ? `<div class="table-wrap"><table><thead><tr><th>EFFECTIVE DATE</th><th>SECURITY / ACCOUNT</th><th>EVENT</th><th>SUPPORTING DETAILS</th></tr></thead><tbody>${state.actions.map((a) => `<tr><td>${e(date(a.effective_date))}</td><td><strong>${e(a.security)}</strong><span class="subtext">${e(accountName(a.portfolio_id))}</span></td><td><span class="pill">${e(pretty(a.kind))}</span></td><td class="row-title">${e(a.notes)}</td></tr>`).join("")}</tbody></table></div>` : empty("Every change deserves a record", "Keep dividends, splits, mergers, rights issues and returns of capital alongside the accounts they affect.", '<button class="button small" data-action="corporate">Record first event ↗</button>')}</section><div class="callout">HL cash transactions show payments received. Share conversions, elections and other non-cash events also need the notice or stock movement report. Recording an event here does not yet change holdings or cost basis.</div>`;
}
function options() {
  return state.portfolios
    .map((p) => `<option value="${e(p.id)}">${e(p.name)}</option>`)
    .join("");
}
function imports() {
  return `<div class="layout"><section class="panel"><div class="panel-head"><h2>Import a statement</h2><span class="pill gray">CSV · up to 200 rows</span></div><div class="panel-body"><div class="form-grid"><label class="field">Source<select id="import-source"><option value="hl">Hargreaves Lansdown</option><option value="sharesight">Sharesight export</option><option value="other">Other broker / spreadsheet</option></select></label><label class="field">Destination account<select id="import-account"><option value="">Select an account</option>${options()}</select></label></div>${state.portfolios.length ? "" : '<p class="fine">Add an account before importing. <button class="button ghost small" data-action="account">＋ Add account</button></p>'}<div class="dropzone"><strong>A place for the original record.</strong><p>CSV with a header row. Capital and income can be imported separately.</p><input id="csv-file" type="file" accept=".csv,text/csv" aria-label="Choose CSV statement"></div><div id="mapping"></div><div id="preview"></div></div><div class="import-info">Each row enters review, with its original file and duplicate checks. PDF contract notes and other document formats are planned.</div></section><div><section class="panel"><div class="panel-head"><h2>For Hargreaves Lansdown</h2><span class="pill">IMPORT WORKFLOW</span></div><div class="steps">${[
    [
      "1",
      "Download capital and income activity",
      "Use the full available date range and include closed positions.",
    ],
    [
      "2",
      "Map the exact columns",
      "Use total cash amounts, not prices quoted in pence. Confirm identifiers and fees against contract notes.",
    ],
    [
      "3",
      "Keep corporate-action notices",
      "Cash alone does not explain splits, elections or cost allocations.",
    ],
  ]
    .map(
      ([n, t, p]) =>
        `<div class="step"><span class="step-n">${n}</span><div><h3>${t}</h3><p>${p}</p></div></div>`,
    )
    .join(
      "",
    )}</div></section><div class="callout">This release supports reviewed file imports. An automatic HL account connection has not been established.</div></div></div><section class="panel"><div class="panel-head"><h2>Original files</h2><small>Private archive · latest 100 imports</small></div>${state.imports.length ? `<div class="table-wrap"><table><thead><tr><th>FILE</th><th>ACCOUNT</th><th>RECORDS</th><th>ARCHIVED</th><th>ORIGINAL</th></tr></thead><tbody>${state.imports.map((i) => `<tr><td class="row-title">${e(i.filename)}<span class="subtext">${e(i.source.toUpperCase())}</span></td><td>${e(accountName(i.portfolio_id))}</td><td>${i.row_count}</td><td>${e(date(i.created_at))}</td><td><a class="button small" href="/api/imports/${e(i.id)}/file">Download ↓</a></td></tr>`).join("")}</tbody></table></div>` : empty("Your source files stay with you", "Each imported CSV is preserved with a content hash and linked to its records.")}</section>`;
}
function feeds() {
  return `<div class="integration-grid">${[
    [
      "HL",
      "File imports",
      "Hargreaves Lansdown",
      "Import capital and income transactions. Record non-cash events from notices and stock movement reports.",
      "imports",
      "Import HL records",
    ],
    [
      "s.",
      "Not connected",
      "Sharesight",
      "The complete migration is still to be run. Exported CSV records can be mapped and archived here.",
      "imports",
      "Import an export",
    ],
    [
      "xero",
      "Not connected",
      "Company accounting",
      "Organisation selection, account mapping and reconciliation come next. This release posts no accounting entries.",
      "features",
      "Choose accounting features",
    ],
  ]
    .map(
      ([logo, status, t, p, v, button]) =>
        `<section class="integration"><div class="integration-header"><span class="provider">${logo}</span><span class="pill gray">${status}</span></div><h2>${t}</h2><p>${p}</p><button class="button small" data-view="${v}">${button} ↗</button></section>`,
    )
    .join(
      "",
    )}<section class="integration"><div class="integration-header"><span class="provider">↔</span><span class="pill">Every four hours</span></div><h2>Crypto prices & currency rates</h2><p>Kraken observations for BTC, ETH, LINK and XMR; ECB reference FX. Wrapped and staked tokens need separate mappings.</p><button class="button small" data-action="refresh-feeds">↻ Refresh free feeds</button></section></div><section class="panel"><div class="panel-head"><h2>Latest stored observations</h2><small>Source dates always retained</small></div>${state.prices.length || state.fx.length ? `<div class="table-wrap"><table><thead><tr><th>INSTRUMENT / PAIR</th><th>OBSERVATION</th><th>SOURCE</th><th>OBSERVED / EFFECTIVE</th></tr></thead><tbody>${state.prices.map((p) => `<tr><td>${e(p.instrument)} / ${e(p.currency)}</td><td class="number-cell">${e(p.price)}</td><td>${e(p.source)}</td><td>${e(new Date(p.observed_at).toLocaleString("en-GB"))}</td></tr>`).join("")}${state.fx.map((f) => `<tr><td>${e(f.base_currency)} / ${e(f.quote_currency)}</td><td class="number-cell">${e(f.rate)}</td><td>${e(f.source)}</td><td>${e(date(f.effective_date))}</td></tr>`).join("")}</tbody></table></div>` : empty("No prices have been fetched yet", "Refresh the feeds or wait for the next scheduled check. There are no example prices mixed into your data.")}</section><p class="fine">Kraken values are last-trade observations, not historical closing prices. ECB reference rates are separate from your broker’s actual execution rates. Historical backfill is still to be implemented.</p>${state.feedRuns.length ? `<section class="panel"><div class="panel-head"><h2>Recent refreshes</h2><small>Latest 10 results</small></div><div class="table-wrap"><table><thead><tr><th>PROVIDER</th><th>RESULT</th><th>RECORDS</th><th>TIME</th></tr></thead><tbody>${state.feedRuns.map((r) => `<tr><td>${e(r.provider)}</td><td><span class="pill ${r.status === "ok" ? "green" : "amber"}">${e(r.status)}</span>${r.message ? '<span class="subtext">' + e(r.message) + "</span>" : ""}</td><td>${r.record_count}</td><td>${e(new Date(r.created_at).toLocaleString("en-GB"))}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
}
function choice(f) {
  return (
    state.choices.find((c) => c.feature_id === f.id)?.choice || f.defaultChoice
  );
}
function features() {
  const all = groups.flatMap((g) => g.items);
  return `<div class="feature-toolbar"><p><strong>${all.filter((f) => choice(f) !== "undecided").length} / ${all.length}</strong> choices made · ${all.filter((f) => choice(f) === "now").length} needed now<br>Choices save to your private workspace.</p><button class="button" data-action="download-plan">↓ Download choices</button></div>${groups
    .map(
      (g) =>
        `<details class="feature-group"><summary>${e(g.name)}<small>${g.items.length} features</small></summary>${g.items
          .map(
            (f) =>
              `<div class="feature-row"><div><span class="feature-id">${e(f.id)}</span><span>${e(f.title)}</span></div><select data-feature="${e(f.id)}" aria-label="Priority for ${e(f.title)}">${[
                ["undecided", "Undecided"],
                ["now", "Need now"],
                ["later", "Later"],
                ["no", "Don’t need"],
              ]
                .map(
                  ([v, label]) =>
                    `<option value="${v}" ${choice(f) === v ? "selected" : ""}>${label}</option>`,
                )
                .join("")}</select></div>`,
          )
          .join("")}</details>`,
    )
    .join(
      "",
    )}<p class="fine">Selecting a feature sets a priority. It does not mean that feature has already been implemented.</p>`;
}
function render() {
  const t = title[view];
  $("#eyebrow").textContent = t[0];
  $("#title").innerHTML = t[1];
  $("#description").textContent = t[2];
  $("#breadcrumb").textContent = names[view];
  document.querySelectorAll(".nav").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#view").innerHTML = {
    overview,
    activity,
    actions,
    imports,
    feeds,
    features,
  }[view]();
  if (view === "imports" && importFile) mapping();
}
function dialog(t, content, fn, label = "Save") {
  if (!authenticated()) return;
  $("#dialog-title").textContent = t;
  $("#dialog-body").innerHTML = content;
  $("#dialog-error").textContent = "";
  $("#dialog-submit").textContent = label;
  handler = fn;
  $("#dialog").showModal();
}
function newAccount() {
  dialog(
    "Add an account",
    `<label class="field">Account name<input name="name" required maxlength="200" placeholder="e.g. HL Stocks & Shares ISA"></label><div class="form-grid"><label class="field">Account type<select name="kind">${["isa", "lisa", "sipp", "company", "personal", "junior", "other"].map((k) => `<option value="${k}">${["isa", "lisa", "sipp"].includes(k) ? k.toUpperCase() : pretty(k)}</option>`).join("")}</select></label><label class="field">Base currency<input name="currency" value="GBP" required pattern="[A-Za-z]{3}" maxlength="3"></label></div>`,
    (b) => request("/api/portfolios", b),
    "Create account",
  );
}
function newAction() {
  if (!state.portfolios.length) {
    toast("Add an account first.");
    newAccount();
    return;
  }
  dialog(
    "Record a corporate action",
    `<label class="field">Account<select name="portfolioId">${options()}</select></label><div class="form-grid"><label class="field">Effective date<input name="date" type="date" required></label><label class="field">Event<select name="kind">${["dividend", "split", "consolidation", "merger", "demerger", "rights", "return_of_capital", "rename", "other"].map((k) => `<option value="${k}">${pretty(k)}</option>`).join("")}</select></label></div><label class="field">Security / ISIN<input name="security" required maxlength="200" placeholder="Exact investment identifier"></label><label class="field">Supporting details<textarea name="notes" required maxlength="4000" placeholder="Notice date, source reference, ratio, payment or election details…"></textarea></label><p class="fine">This saves the event record. It does not change holdings or calculate tax.</p>`,
    (b) => request("/api/actions", b),
    "Save event",
  );
}
function review(id) {
  const r = state.entries.find((r) => r.id === id);
  if (!r) return;
  dialog(
    "Review source record",
    `<p>${e(r.description || r.security || pretty(r.kind))}</p><p class="fine">${e(date(r.occurred_on))} · ${e(r.amount ?? "No cash amount")} ${e(r.currency)}</p><div class="notice">${e([...JSON.parse(r.errors_json), ...JSON.parse(r.warnings_json)].join(" ") || "Check against the original source before accepting.")}</div><label class="field">Transaction type<select name="kind">${["buy", "sell", "dividend", "interest", "fee", "deposit", "withdrawal", "transfer", "corporate_action", "unclassified"].map((k) => `<option value="${k}" ${k === r.kind ? "selected" : ""}>${pretty(k)}</option>`).join("")}</select></label><label class="field">Decision<select name="status"><option value="accepted">Accept source record</option><option value="review">Keep in review</option><option value="ignored">Ignore (preserve original)</option></select></label>`,
    (b) => request(`/api/entries/${id}/status`, b),
    "Save review",
  );
}
const fields = [
  ["date", "Date", /^(date|trade date|transaction date|payment date)$/i],
  ["type", "Transaction type", /^(type|transaction type|transaction)$/i],
  ["description", "Description", /^(description|details|investment)$/i],
  [
    "security",
    "Security / ISIN",
    /^(security|ticker|symbol|isin|stock|investment code)$/i,
  ],
  ["quantity", "Quantity", /^(quantity|units|shares)$/i],
  [
    "amount",
    "Total cash amount",
    /^(amount|value|total|cash amount|net amount|net consideration)( ?\(.*\))?$/i,
  ],
  ["currency", "Cash currency", /^currency$/i],
  ["reference", "Reference", /^(reference|ref|transaction id|trade id)$/i],
];
function mapping() {
  preview = null;
  $("#mapping").innerHTML =
    `<h3 class="mapping-title">Match your columns</h3><p class="fine">${e(importFile.name)} · ${importFile.parsed.rows.length} rows. No prices or cash signs are guessed.</p><div class="mapping-grid">${fields
      .map(([key, label, re]) => {
        const guessed = importFile.parsed.headers.findIndex((h) => re.test(h));
        return `<label class="field">${label}<select data-map="${key}"><option value="-1">Not provided</option>${importFile.parsed.headers.map((h, i) => `<option value="${i}" ${i === guessed ? "selected" : ""}>${e(h) || "Column " + (i + 1)}</option>`).join("")}</select></label>`;
      })
      .join(
        "",
      )}</div><button class="button primary" data-action="preview-import">Preview records ↗</button>`;
}
function payload() {
  const portfolioId = $("#import-account").value;
  if (!portfolioId) throw Error("Select a destination account.");
  return {
    portfolioId,
    source: $("#import-source").value,
    filename: importFile.name,
    csv: importFile.csv,
    mapping: Object.fromEntries(
      [...document.querySelectorAll("[data-map]")].map((s) => [
        s.dataset.map,
        Number(s.value),
      ]),
    ),
  };
}
async function previewImport() {
  if (!authenticated() || !importFile) return;
  preview = await request("/api/imports/preview", payload());
  $("#preview").innerHTML =
    `<div class="callout">${preview.count} records ready for review. ${preview.errorCount} have validation errors. No investment balances are calculated.</div><div class="table-wrap"><table><thead><tr><th>DATE</th><th>RECORD</th><th>AMOUNT</th><th>CHECKS</th></tr></thead><tbody>${preview.rows
      .slice(0, 10)
      .map(
        (r) =>
          `<tr><td>${e(r.occurred_on || "—")}</td><td class="row-title">${e(r.security || r.description || r.kind)}</td><td>${e(r.amount ?? "—")} ${e(r.currency)}</td><td class="row-title">${e([...r.errors, ...r.warnings].join(" ") || "Ready to review")}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table></div><p class="fine">Showing the first ${Math.min(preview.count, 10)} records.</p><button class="button primary" data-action="commit-import">Archive ${preview.count} records for review</button>`;
}
function download(name, data) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("button,a");
  if (!target) return;
  if (target.dataset.view) {
    go(target.dataset.view);
    return;
  }
  if (target.dataset.review) {
    review(target.dataset.review);
    return;
  }
  const action = target.dataset.action;
  if (!action) return;
  try {
    if (action === "account") newAccount();
    else if (action === "corporate") newAction();
    else if (action === "export") {
      if (authenticated()) window.location.assign("/api/export");
    } else if (action === "download-plan")
      download("portfolio-feature-choices.json", {
        exportedAt: new Date().toISOString(),
        features: groups.flatMap((g) =>
          g.items.map((f) => ({ id: f.id, title: f.title, choice: choice(f) })),
        ),
      });
    else if (action === "preview-import") {
      target.disabled = true;
      await previewImport();
    } else if (action === "commit-import") {
      if (!preview) return;
      target.disabled = true;
      const result = await request("/api/imports", payload());
      importFile = null;
      preview = null;
      await refresh();
      go("activity");
      toast(`${result.count} records archived for review.`);
    } else if (action === "refresh-feeds") {
      if (!authenticated()) return;
      target.disabled = true;
      target.textContent = "Refreshing…";
      const result = await request("/api/feeds/refresh", {});
      await refresh();
      toast(
        result.results.every((r) => r.status === "ok")
          ? "Prices and currency rates refreshed."
          : "Refresh finished with gaps. See provider results.",
      );
    }
  } catch (error) {
    toast(error.message);
  } finally {
    target.disabled = false;
    if (action === "refresh-feeds" && target.isConnected)
      target.textContent = "↻ Refresh free feeds";
  }
});
function filterEntries() {
  const q = $("#search").value.toLowerCase(),
    status = $("#status").value;
  $("#entry-results").innerHTML = entryTable(
    state.entries.filter(
      (r) =>
        (status === "all" || r.status === status) &&
        [r.description, r.security, r.kind, accountName(r.portfolio_id)]
          .join(" ")
          .toLowerCase()
          .includes(q),
    ),
  );
}
document.addEventListener("input", (event) => {
  if (event.target.id === "search") filterEntries();
});
document.addEventListener("change", async (event) => {
  const t = event.target;
  try {
    if (t.id === "status") filterEntries();
    if (t.id === "csv-file") {
      const file = t.files[0];
      if (!file) return;
      if (file.size > 2000000) throw Error("Choose a CSV smaller than 2 MB.");
      let csv;
      try {
        csv = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw Error("Save this statement as UTF-8 CSV before importing.");
      }
      importFile = { name: file.name, csv, parsed: parseCSV(csv) };
      mapping();
      $("#preview").innerHTML = "";
    }
    if (t.dataset.map || ["import-source", "import-account"].includes(t.id)) {
      preview = null;
      $("#preview").innerHTML = "";
    }
    if (t.dataset.feature) {
      if (!authenticated()) return;
      const id = t.dataset.feature,
        previous = choice(
          groups.flatMap((g) => g.items).find((f) => f.id === id),
        );
      try {
        await request("/api/features", { id, choice: t.value });
        state.choices = state.choices
          .filter((c) => c.feature_id !== id)
          .concat({ feature_id: id, choice: t.value });
        const all = groups.flatMap((g) => g.items);
        $(".feature-toolbar p").innerHTML =
          `<strong>${all.filter((f) => choice(f) !== "undecided").length} / ${all.length}</strong> choices made · ${all.filter((f) => choice(f) === "now").length} needed now<br>Choices save to your private workspace.`;
        toast("Feature choice saved.");
      } catch (error) {
        t.value = previous;
        throw error;
      }
    }
  } catch (error) {
    toast(error.message);
  }
});
$("#close-dialog").addEventListener("click", () => $("#dialog").close());
$("#dialog-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#dialog-submit").disabled = true;
  try {
    await handler(Object.fromEntries(new FormData(event.target)));
    $("#dialog").close();
    await refresh();
    toast("Saved to your workspace.");
  } catch (error) {
    $("#dialog-error").textContent = error.message;
  } finally {
    $("#dialog-submit").disabled = false;
  }
});
render();
refresh();
