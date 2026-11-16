import { normalizeCSV, sha256, isoDate } from "./imports.js";
import { refreshFeeds } from "./feeds.ts";
class InputError extends Error {}
const fail = (m: string): never => {
  throw new InputError(m);
};
const text = (v: unknown, max = 200) =>
  typeof v === "string" && v.length <= max
    ? v.trim()
    : fail("Invalid text field.");
const audit = (db: D1Database, event: string, id: string, detail: unknown) =>
  db
    .prepare("INSERT INTO audit_log VALUES(?,?,?,?,?)")
    .bind(
      crypto.randomUUID(),
      event,
      id,
      JSON.stringify(detail),
      new Date().toISOString(),
    );
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    fail("Use JSON.");
  const reader = request.body?.getReader();
  if (!reader) return fail("Missing request body.");
  let size = 0,
    s = "";
  const decoder = new TextDecoder();
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 2100000) {
      await reader.cancel();
      return fail("Request exceeds 2 MB.");
    }
    s += decoder.decode(part.value, { stream: true });
  }
  try {
    const parsed: unknown = JSON.parse(s + decoder.decode());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return fail("Expected an object.");
    return parsed as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON.");
  }
}
const kinds = [
  "buy",
  "sell",
  "dividend",
  "interest",
  "fee",
  "deposit",
  "withdrawal",
  "transfer",
  "corporate_action",
  "unclassified",
];
export async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  try {
    if (
      request.method !== "GET" &&
      request.headers.get("Origin") !== url.origin
    )
      return json({ error: "Request origin is not allowed." }, 403);
    if (request.method === "GET" && path === "/api/state") {
      const db = env.DB;
      const queries = [
        "SELECT * FROM portfolios ORDER BY created_at",
        "SELECT * FROM imports ORDER BY created_at DESC LIMIT 100",
        "SELECT COUNT(*) AS count FROM entries",
        "SELECT COUNT(*) AS count FROM entries WHERE status='review'",
        "SELECT * FROM corporate_actions ORDER BY effective_date DESC LIMIT 100",
        "SELECT * FROM feature_choices",
        "SELECT * FROM feed_runs ORDER BY created_at DESC LIMIT 10",
        "SELECT p.* FROM prices p JOIN (SELECT instrument,MAX(observed_at) AS latest FROM prices GROUP BY instrument) q ON p.instrument=q.instrument AND p.observed_at=q.latest",
        "SELECT * FROM exchange_rates WHERE quote_currency IN ('GBP','USD','THB','PLN') AND effective_date=(SELECT MAX(effective_date) FROM exchange_rates)",
        "SELECT id,portfolio_id,occurred_on,kind,description,security,quantity,amount,currency,status,errors_json,warnings_json FROM entries ORDER BY created_at DESC,row_number LIMIT 100",
      ];
      const results = await Promise.all(
        queries.map((sql) => db.prepare(sql).all()),
      );
      return json({
        portfolios: results[0].results,
        imports: results[1].results,
        entryCount: results[2].results[0].count,
        reviewCount: results[3].results[0].count,
        actions: results[4].results,
        choices: results[5].results,
        feedRuns: results[6].results,
        prices: results[7].results,
        fx: results[8].results,
        entries: results[9].results,
      });
    }
    if (request.method === "POST" && path === "/api/portfolios") {
      const b = await body(request),
        name = text(b.name),
        kind = text(b.kind),
        currency = text(b.currency).toUpperCase();
      if (
        !name ||
        ![
          "isa",
          "lisa",
          "sipp",
          "company",
          "personal",
          "junior",
          "other",
        ].includes(kind) ||
        !/^[A-Z]{3}$/.test(currency) ||
        currency === "GBX"
      )
        fail("Enter a name, account type and currency.");
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO portfolios VALUES(?,?,?,?,?)").bind(
          id,
          name,
          kind,
          currency,
          new Date().toISOString(),
        ),
        audit(env.DB, "portfolio.created", id, { kind, currency }),
      ]);
      return json({ id }, 201);
    }
    if (
      request.method === "POST" &&
      ["/api/imports/preview", "/api/imports"].includes(path)
    ) {
      const b = await body(request),
        portfolioId = text(b.portfolioId),
        source = text(b.source),
        filename = text(b.filename);
      const csv =
        typeof b.csv === "string" && b.csv.length <= 2000000
          ? b.csv
          : fail("Invalid CSV.");
      if (!["hl", "sharesight", "other"].includes(source))
        fail("Choose an import source.");
      const portfolio = await env.DB.prepare(
        "SELECT currency FROM portfolios WHERE id=?",
      )
        .bind(portfolioId)
        .first<{ currency: string }>();
      if (!portfolio) fail("Choose an existing account.");
      const hash = await sha256(csv);
      if (
        await env.DB.prepare(
          "SELECT id FROM imports WHERE portfolio_id=? AND sha256=?",
        )
          .bind(portfolioId, hash)
          .first()
      )
        return json(
          { error: "This exact file is already archived for this account." },
          409,
        );
      let rows;
      try {
        rows = await normalizeCSV(csv, b.mapping, portfolio!.currency);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "Invalid CSV.");
      }
      const fingerprints = new Set<string>();
      for (let i = 0; i < rows.length; i += 80) {
        const part = rows.slice(i, i + 80);
        const existing = await env.DB.prepare(
          `SELECT fingerprint FROM entries WHERE portfolio_id=? AND fingerprint IN (${part.map(() => "?").join(",")})`,
        )
          .bind(portfolioId, ...part.map((r) => r.fingerprint))
          .all<{ fingerprint: string }>();
        existing.results.forEach((r) => fingerprints.add(r.fingerprint));
      }
      for (const row of rows) {
        if (
          new TextEncoder().encode(JSON.stringify(row.raw)).byteLength > 500000
        )
          fail("A source row is too large; split or simplify this export.");
        if (fingerprints.has(row.fingerprint))
          row.warnings.push(
            "Possible duplicate: compare with earlier records.",
          );
        fingerprints.add(row.fingerprint);
      }
      if (path.endsWith("/preview"))
        return json({
          rows,
          count: rows.length,
          errorCount: rows.filter((r) => r.errors.length).length,
        });
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      const statements = [
        env.DB.prepare("INSERT INTO imports VALUES(?,?,?,?,?,?,?)").bind(
          id,
          portfolioId,
          source,
          filename,
          hash,
          rows.length,
          now,
        ),
      ];
      const characters = Array.from(csv);
      for (let i = 0; i < characters.length; i += 32000)
        statements.push(
          env.DB.prepare("INSERT INTO original_chunks VALUES(?,?,?)").bind(
            id,
            i / 32000,
            characters.slice(i, i + 32000).join(""),
          ),
        );
      for (const r of rows)
        statements.push(
          env.DB.prepare(
            "INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          ).bind(
            crypto.randomUUID(),
            id,
            portfolioId,
            r.row_number,
            r.occurred_on,
            r.kind,
            r.description,
            r.security,
            r.quantity,
            r.amount,
            r.currency,
            r.reference,
            r.fingerprint,
            JSON.stringify(r.raw),
            JSON.stringify(r.errors),
            JSON.stringify(r.warnings),
            "review",
            now,
          ),
        );
      statements.push(
        audit(env.DB, "import.archived", id, { hash, rows: rows.length }),
      );
      await env.DB.batch(statements);
      return json({ id, count: rows.length }, 201);
    }
    const entry = /^\/api\/entries\/([a-f0-9-]+)\/status$/.exec(path);
    if (request.method === "POST" && entry) {
      const b = await body(request),
        status = text(b.status),
        kind = text(b.kind);
      if (
        !["accepted", "ignored", "review"].includes(status) ||
        !kinds.includes(kind)
      )
        fail("Invalid review decision.");
      const row = await env.DB.prepare(
        "SELECT kind,status,errors_json FROM entries WHERE id=?",
      )
        .bind(entry[1])
        .first<{ kind: string; status: string; errors_json: string }>();
      if (!row) return json({ error: "Record not found." }, 404);
      if (
        status === "accepted" &&
        (kind === "unclassified" || JSON.parse(row.errors_json).length)
      )
        fail(
          "Classify the record, or correct the source file and reimport before accepting.",
        );
      await env.DB.batch([
        env.DB.prepare("UPDATE entries SET status=?,kind=? WHERE id=?").bind(
          status,
          kind,
          entry[1],
        ),
        audit(env.DB, "entry.reviewed", entry[1], {
          before: row,
          after: { status, kind },
        }),
      ]);
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/actions") {
      const b = await body(request),
        portfolioId = text(b.portfolioId),
        date = isoDate(text(b.date)),
        kind = text(b.kind),
        security = text(b.security),
        notes = text(b.notes, 4000);
      if (
        !date ||
        !security ||
        !notes ||
        ![
          "dividend",
          "split",
          "consolidation",
          "merger",
          "demerger",
          "rights",
          "return_of_capital",
          "rename",
          "other",
        ].includes(kind)
      )
        fail("Enter the date, event, security and supporting details.");
      if (
        !(await env.DB.prepare("SELECT id FROM portfolios WHERE id=?")
          .bind(portfolioId)
          .first())
      )
        fail("Choose an existing account.");
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO corporate_actions VALUES(?,?,?,?,?,?,?)",
        ).bind(
          id,
          portfolioId,
          date,
          kind,
          security,
          notes,
          new Date().toISOString(),
        ),
        audit(env.DB, "action.recorded", id, { date, kind }),
      ]);
      return json({ id }, 201);
    }
    if (request.method === "POST" && path === "/api/features") {
      const b = await body(request),
        id = text(b.id),
        choice = text(b.choice);
      if (
        !/^[A-I]\d{2}$/.test(id) ||
        !["undecided", "now", "later", "no"].includes(choice)
      )
        fail("Invalid feature choice.");
      await env.DB.prepare(
        "INSERT INTO feature_choices VALUES(?,?,?) ON CONFLICT(feature_id) DO UPDATE SET choice=excluded.choice,updated_at=excluded.updated_at",
      )
        .bind(id, choice, new Date().toISOString())
        .run();
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/feeds/refresh") {
      const last = await env.DB.prepare(
        "SELECT created_at FROM feed_runs ORDER BY created_at DESC LIMIT 1",
      ).first<{ created_at: string }>();
      if (last && Date.now() - Date.parse(last.created_at) < 300000)
        return json(
          { error: "Recently refreshed. Try again in five minutes." },
          429,
        );
      return json({ results: await refreshFeeds(env) });
    }
    const file = /^\/api\/imports\/([a-f0-9-]+)\/file$/.exec(path);
    if (request.method === "GET" && file) {
      const chunks = await env.DB.prepare(
        "SELECT content FROM original_chunks WHERE import_id=? ORDER BY chunk_index",
      )
        .bind(file[1])
        .all<{ content: string }>();
      if (!chunks.results.length)
        return json({ error: "File not found." }, 404);
      return new Response(chunks.results.map((c) => c.content).join(""), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="original.csv"',
        },
      });
    }
    if (request.method === "GET" && path === "/api/export") {
      const tables = [
        "portfolios",
        "imports",
        "entries",
        "corporate_actions",
        "feature_choices",
        "prices",
        "exchange_rates",
        "feed_runs",
        "audit_log",
      ];
      const data: Record<string, unknown> = {
        version: 1,
        exportedAt: new Date().toISOString(),
        note: "Original CSV files are downloaded separately from the import centre.",
      };
      for (const table of tables) {
        const count = await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM ${table}`,
        ).first<{ count: number }>();
        if ((count?.count ?? 0) > 10000)
          return json(
            {
              error:
                "This archive needs a streamed export; no partial backup was generated.",
            },
            413,
          );
        data[table] = (
          await env.DB.prepare(`SELECT * FROM ${table}`).all()
        ).results;
      }
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition":
            'attachment; filename="portfolio-records.json"',
        },
      });
    }
    return json({ error: "Endpoint not found." }, 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400);
    console.error(JSON.stringify({ event: "request_failed", path }));
    return json(
      {
        error:
          "The request could not be completed. Your records have not been silently changed.",
      },
      500,
    );
  }
}
