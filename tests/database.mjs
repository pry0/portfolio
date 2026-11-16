import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export function database() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  function statement(sql, args = []) {
    return {
      bind(...values) {
        return statement(sql, values);
      },
      async first() {
        return raw.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: raw.prepare(sql).all(...args), success: true };
      },
      async run() {
        return { meta: raw.prepare(sql).run(...args), success: true };
      },
    };
  }
  const DB = {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        raw.exec("COMMIT");
        return result;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { DB, raw };
}
