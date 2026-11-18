// Run after npm run build. Uses only synthetic records and an isolated D1.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync,readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { sealToken } from "../src/sharesight.ts";
const root=new URL("../",import.meta.url), key="cd".repeat(32);
const mf=new Miniflare(convertV4MiniflareOptions({
  scriptPath:new URL(".cloudflare/output/v0/workers/default/bundle/index.js",root).pathname,
  modules:true,compatibilityDate:"2026-11-16",host:"127.0.0.1",port:0,inspectorPort:0,
  d1Databases:{DB:"smoke-only"},bindings:{LOCAL_DEVELOPMENT:"true",MIGRATION_KEY:key},
  outboundService:async request=>{
    assert.equal(request.method,"GET");assert.equal(request.headers.get("Authorization"),"Bearer synthetic-token");
    assert.equal(new URL(request.url).pathname,"/api/v2/portfolios/1/trades.json");
    return new Response('{"trades":[{"id":1,"portfolio_id":1,"holding_id":9,"transaction_type":"SELL","quantity":0.1234567890123456789,"state":"confirmed"},{"id":null,"portfolio_id":1,"holding_id":9,"transaction_type":"SPLIT","state":"unconfirmed"}]}',{headers:{"Content-Type":"application/json"}});
  },
}));
try {
  const db=await mf.getD1Database("DB");
  for(const name of readdirSync(new URL("migrations/",root)).filter(n=>n.endsWith(".sql")).sort()) {
    const statements=readFileSync(new URL("migrations/"+name,root),"utf8").split(";").map(s=>s.trim()).filter(Boolean);
    await db.batch(statements.map(s=>db.prepare(s)));
  }
  const runId=crypto.randomUUID(), jobId=crypto.randomUUID();
  const cipher=await sealToken({MIGRATION_KEY:key},"synthetic-token",runId);
  await db.prepare("INSERT INTO sharesight_runs(id,source_user_id,status,as_of,created_at,updated_at,token_cipher,token_expires) VALUES(?,?,'running',?,?,?,?,?)").bind(runId,"1","2026-11-18","now","now",cipher,Date.now()+600000).run();
  await db.prepare("INSERT INTO sharesight_jobs(id,run_id,path,category,portfolio_id,created_at) VALUES(?,?,?,'trades','1','now')").bind(jobId,runId,"/api/v2/portfolios/1/trades.json").run();
  const response=await mf.dispatchFetch(`http://localhost/api/sharesight/runs/${runId}/step`,{method:"POST",headers:{Origin:"http://localhost","Content-Type":"application/json"},body:"{}"});
  assert.equal(response.status,200,await response.clone().text());
  const records=await db.prepare("SELECT raw_json FROM sharesight_records WHERE kind='trade'").all();
  assert.equal(records.results.length,2);
  assert(records.results.some(r=>JSON.parse(r.raw_json).quantity==="0.1234567890123456789"));
  assert.equal((await db.prepare("SELECT status FROM sharesight_jobs WHERE id=?").bind(jobId).first()).status,"done");
  assert.equal((await mf.dispatchFetch("https://portfolio.example.test/api/sharesight/status")).status,401);
  assert.equal((await mf.dispatchFetch("http://localhost/api/sharesight/status",{method:"POST",headers:{Origin:"https://evil.test"}})).status,403);
  assert((await(await mf.dispatchFetch("http://localhost/")).text()).includes("Sharesight migration"));
  const asset=await mf.dispatchFetch("http://localhost/sharesight-ui.js");assert.equal(asset.status,200);
  console.log("Compiled Worker smoke passed: real D1, encrypted token, exact decimals, closed-holding discovery, access checks and UI asset.");
} finally {await mf.dispose();}
