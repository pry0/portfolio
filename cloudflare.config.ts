import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
export default defineConfig(({ mode }) => ({
  accountId: "fdea5d8829849b23627952e6f6487e36",
  worker: {
    name: "portfolio",
    compatibilityDate: "2026-11-16",
    entrypoint,
    domains: ["portfolio.pry0.com"],
    workersDev: false,
    previewUrls: false,
    env: {
      DB: bindings.d1({
        name: "portfolio-db",
        id: "20a4825a-75c7-4f5c-9f55-56ca6edaeb31",
      }),
      ACCESS_TEAM_DOMAIN: bindings.secret(),
      ACCESS_AUD: bindings.secret(),
      OWNER_EMAIL: bindings.secret(),
      LOCAL_DEVELOPMENT: bindings.text(
        mode === "development" ? "true" : "false",
      ),
    },
    triggers: [triggers.scheduled({ schedule: "15 */4 * * *" })],
    observability: {
      enabled: true,
      redactQueryString: true,
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
  },
}));
