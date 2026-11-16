import html from "./index.html?raw";
import css from "./style.css?raw";
import js from "./app.js?raw";
import csv from "./imports.js?raw";
import features from "./features.js?raw";
import { authorize } from "./auth.ts";
import { api } from "./api.ts";
import { refreshFeeds } from "./feeds.ts";
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    let response: Response;
    if (path === "/api/health" && request.method === "GET")
      response = Response.json({
        ok: true,
        service: "portfolio",
        version: "0.1.0",
      });
    else if (path.startsWith("/api/"))
      response = (await authorize(request, env))
        ? await api(request, env)
        : Response.json(
            { error: "Sign in to your private workspace." },
            { status: 401 },
          );
    else if (!["GET", "HEAD"].includes(request.method))
      response = new Response("Method not allowed", { status: 405 });
    else {
      const routes: Record<string, [string, string]> = {
        "/": [html, "text/html"],
        "/style.css": [css, "text/css"],
        "/app.js": [js, "text/javascript"],
        "/imports.js": [csv, "text/javascript"],
        "/features.js": [features, "text/javascript"],
        "/robots.txt": ["User-agent: *\nDisallow: /\n", "text/plain"],
      };
      const asset = routes[path];
      response = asset
        ? new Response(request.method === "HEAD" ? null : asset[0], {
            headers: { "Content-Type": asset[1] + "; charset=utf-8" },
          })
        : new Response("Not found", { status: 404 });
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Robots-Tag", "noindex,nofollow,noarchive");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set(
      "Permissions-Policy",
      "camera=(),microphone=(),geolocation=()",
    );
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    return response;
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshFeeds(env));
  },
} satisfies ExportedHandler<Env>;
