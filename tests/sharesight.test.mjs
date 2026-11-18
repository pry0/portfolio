import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api.ts";
import { exactJSON, safePath, inspectResponse } from "../src/sharesight-model.ts";
import { sealToken, boundedBytes } from "../src/sharesight.ts";
import { sha256 } from "../src/imports.js";
import { database } from "./database.mjs";
const origin="https://portfolio.example.test";
const call=(env,path,data)=>api(new Request(origin+path,data===undefined?{}:{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(data)}),env);
const key="ab".repeat(32);
test("numeric tokens, large IDs and nested financial fields remain exact",()=>{
  const d=exactJSON('{"id":9007199254740993,"quantity":0.1234567890123456789,"x":1.2300e-12,"name":"1234 -5 \\"quoted\\"","b":true,"n":null}');
  assert.equal(d.id,"9007199254740993");assert.equal(d.quantity,"0.1234567890123456789");assert.equal(d.x,"1.2300e-12");assert.equal(d.b,true);assert.equal(d.n,null);
  assert.throws(()=>exactJSON('{"x":01}'));
});
test("source URLs are read-only and restricted; pagination cannot change the endpoint",async()=>{
  for(const p of ["https://evil.test/api/v2/portfolios.json","/api/v2/single_sign_on.json","/api/v3/connections","/api/v2/portfolios.json?access_token=oops","//localhost/api/v2/portfolios.json"])
    assert.throws(()=>safePath(p));
  const j={path:"/api/v3/custom_investment/22/prices.json?per_page=100&page=abc",category:"custom_prices",portfolioId:"1"};
  await assert.rejects(inspectResponse(j,{prices:[],pagination:{page:"abc"}},"2026-11-18",sha256),/Repeated/);
  await assert.rejects(inspectResponse(j,{prices:[],links:{next:"https://evil.test/next"}},"2026-11-18",sha256),/Unexpected/);
});
test("sold and unconfirmed trades discover holdings even when absent from current holdings",async()=>{
  const data=exactJSON('{"trades":[{"id":100,"holding_id":90,"portfolio_id":1,"transaction_type":"SELL","quantity":1,"state":"confirmed"},{"id":null,"holding_id":91,"transaction_type":"SPLIT","state":"unconfirmed"}]}');
  const out=await inspectResponse({path:"/api/v2/portfolios/1/trades.json",category:"trades",portfolioId:"1"},data,"2026-11-18",sha256);
  assert.equal(out.records.length,2);assert.equal(out.records[1].sourceState,"unconfirmed");
  assert(out.jobs.some(j=>j.path.includes("/holdings/90?")));assert(out.jobs.some(j=>j.path.includes("/holdings/91?")));
});
test("tokens are encrypted differently each time and oversized bodies are rejected",async()=>{
  const a=await sealToken({MIGRATION_KEY:key},"private-token","run-a"), b=await sealToken({MIGRATION_KEY:key},"private-token","run-a");
  assert.notEqual(a,b);assert(!a.includes("private-token"));
  await assert.rejects(boundedBytes(new Response("123456"),5),/exceeds/);
});
function fixtures(path) {
  const u=new URL(path), p=u.pathname;
  if(p==="/oauth2/token") return {access_token:"temporary-test-token",expires_in:1800};
  if(p==="/api/v2/my_user.json") return {user:{id:1,name:"Test owner"}};
  if(p==="/api/v2/portfolios.json") return {portfolios:[{id:1,name:"Fixture portfolio",currency_code:"GBP"}]};
  if(p==="/api/v3/portfolios") return {portfolios:[]};
  if(p==="/api/v2/portfolios/1.json") return {id:1,name:"Fixture portfolio",currency_code:"GBP",country_code:"GB"};
  if(p==="/api/v2/cash_accounts.json") return {cash_accounts:[{id:5,portfolio_id:1,currency:"GBP",balance:12}]};
  if(p==="/api/v2/cash_accounts/5/cash_account_transactions.json") return {cash_account_transactions:[{id:55,cash_account_id:5,portfolio_id:1,date_time:"2012-05-01",amount:12}]};
  if(p==="/api/v2/portfolios/1/trades.json") return '{"trades":[{"id":100,"portfolio_id":1,"holding_id":90,"transaction_type":"BUY","transaction_date":"2012-05-01","quantity":0.1234567890123456789,"exchange_rate":0.777777777777777777,"state":"confirmed"},{"id":101,"portfolio_id":1,"holding_id":90,"transaction_type":"SELL","transaction_date":"2020-01-01","quantity":0.1234567890123456789,"state":"confirmed","attachment_id":500},{"id":null,"portfolio_id":1,"holding_id":91,"transaction_type":"SPLIT","state":"unconfirmed","company_event_id":44}]}';
  if(p==="/api/v2/portfolios/1/payouts.json") return {payouts:[{id:200,portfolio_id:1,holding_id:90,paid_on:"2013-01-01",amount:2,gross_amount:2.5,currency:"USD",exchange_rate:0.7,state:"confirmed",drp_trade_attributes:{dividend_reinvested:false}}]};
  if(/\/rejected_trades.json$/.test(p)) return {trades:[]};
  if(/\/holdings\/(90|91)$/.test(p)) return {holding:{id:Number(p.split("/").at(-1)),portfolio:{id:1},valid_position:false,instrument:{code:"SOLD"},documents:[]}};
  if(p==="/api/v3/custom_investments") return {custom_investments:[{id:22,portfolio:{id:1},code:"WRAPPED",investment_type:"CRYPTO"}]};
  if(p==="/api/v3/custom_investments/22") return {id:22,portfolio_id:1,name:"Wrapped asset"};
  if(p==="/api/v3/custom_investment/22/prices.json") return {id:22,prices:[{id:u.searchParams.has("page")?302:301,lastTradedPrice:"1.234567890123456789",lastTradedOn:"2015-01-01"}],pagination:{page:u.searchParams.has("page")?null:"next/opaque+cursor=="}};
  if(p.endsWith("/adjustments")) return {adjustments:[{id:77,paid_on:"2016-01-01",amount_per_share:"0.000001"}],pagination:{page:null}};
  if(p==="/api/v2/user_instruments.json") return {instruments:[]};
  if(p==="/api/v2/groups.json") return {groups:[]};
  if(p==="/api/v2/memberships.json") return {memberships:[]};
  if(p==="/api/v2/currencies.json") return {currencies:[]};
  if(p.endsWith("/valuation.json")||p.endsWith("/performance.json")||p.endsWith("/holdings")) return {holdings:[]};
  if(p.endsWith("/user_setting")) return {portfolio_user_setting:{include_sold_shares:false}};
  if(p.endsWith("/performance_index_chart")) return {dates:[],lines:[]};
  if(p.endsWith("/labels")) return new Response("Unavailable",{status:403});
  if(p==="/api/v2/documents/500.json") return new Response(new Uint8Array([0,255,10,34]),{headers:{"Content-Type":"application/pdf"}});
  throw Error("Unexpected endpoint: "+p);
}
async function complete(env,id) {
  for(let i=0;i<100;i++) {
    const r=await call(env,`/api/sharesight/runs/${id}/step`,{});
    assert.equal(r.status,200,await r.clone().text());
    if((await r.json()).status==="awaiting_reconciliation") return;
  }
  assert.fail("Migration did not finish");
}
test("full API migration retains sold records, documents, all price pages, raw bytes and explicit gaps",async()=>{
  const {DB,raw}=database(),env={DB,MIGRATION_KEY:key}, original=globalThis.fetch, requests=[];
  globalThis.fetch=async (url,options)=>{
    requests.push({url:String(url),method:options.method});
    const r=fixtures(String(url));return r instanceof Response?r:typeof r==="string"?new Response(r,{headers:{"Content-Type":"application/json"}}):Response.json(r);
  };
  try {
    const connected=await call(env,"/api/sharesight/connect",{clientId:"fixture-client",clientSecret:"fixture-secret"});
    assert.equal(connected.status,201,await connected.clone().text());const {id}=await connected.json();
    await complete(env,id);
    assert(requests.filter(r=>r.method!=="GET").every(r=>r.url==="https://portfolio.sharesight.com/oauth2/token"));
    assert.equal(raw.prepare("SELECT token_cipher FROM sharesight_runs").get().token_cipher,null);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM portfolios").get().n,1);
    const records=raw.prepare("SELECT * FROM sharesight_records WHERE kind='trade'").all();
    assert.equal(records.length,3);
    assert.equal(JSON.parse(records.find(r=>r.source_id==="100").raw_json).quantity,"0.1234567890123456789");
    assert.equal(records.find(r=>r.source_id===null).source_state,"unconfirmed");
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM sharesight_records WHERE kind='custom_price'").get().n,2);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM sharesight_records WHERE kind='holding'").get().n,2);
    const gap=raw.prepare("SELECT * FROM sharesight_jobs WHERE status='gap'").get();
    assert.equal(gap.category,"labels");assert.equal(gap.http_status,403);
    const doc=raw.prepare("SELECT id FROM sharesight_jobs WHERE category='document'").get();
    assert.deepEqual(new Uint8Array(await (await call(env,`/api/sharesight/responses/${doc.id}`)).arrayBuffer()),new Uint8Array([0,255,10,34]));
    let cursor={phase:"jobs",after:0}, exported=[], loops=0;
    while(cursor) {
      const r=await call(env,`/api/sharesight/runs/${id}/export?phase=${cursor.phase}&after=${cursor.after}`);assert.equal(r.status,200);
      const page=await r.json();exported.push(page);cursor=page.next;assert(++loops<100);
    }
    assert.equal(exported.flatMap(p=>p.section==="records"?p.rows:[]).length,raw.prepare("SELECT COUNT(*) n FROM sharesight_records").get().n);
    assert(!JSON.stringify(exported).includes("temporary-test-token"));assert(!JSON.stringify(exported).includes("fixture-secret"));
    assert(!JSON.stringify(exported).includes("token_cipher"));
    const tradeJob=raw.prepare("SELECT * FROM sharesight_jobs WHERE category='trades'").get();
    const rawBytes=await(await call(env,`/api/sharesight/responses/${tradeJob.id}`)).text();
    assert.equal(rawBytes,fixtures("https://api.sharesight.com/api/v2/portfolios/1/trades.json"));
    // An interrupted fetch can be rerun without duplicating previously indexed records.
    raw.prepare("UPDATE sharesight_jobs SET status='gap' WHERE id=?").run(tradeJob.id);
    await call(env,`/api/sharesight/runs/${id}/retry`,{jobId:tradeJob.id});
    const resumed=await call(env,"/api/sharesight/connect",{runId:id,clientId:"fixture-client",clientSecret:"fixture-secret"});assert.equal(resumed.status,200);
    await complete(env,id);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM sharesight_records WHERE kind='trade'").get().n,3);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM entries").get().n,0); // no invented accounting ledger
  } finally {globalThis.fetch=original;raw.close();}
});
test("CSRF, expired sessions and concurrent steps stop before source reads",async()=>{
  const {DB,raw}=database(),env={DB,MIGRATION_KEY:key},original=globalThis.fetch;
  globalThis.fetch=()=>{throw Error("Must not fetch");};
  try {
    const blocked=await api(new Request(origin+"/api/sharesight/connect",{method:"POST",headers:{Origin:"https://evil.test"}}),env);assert.equal(blocked.status,403);
    const id=crypto.randomUUID();
    raw.prepare("INSERT INTO sharesight_runs(id,source_user_id,status,as_of,created_at,updated_at,token_cipher,token_expires) VALUES(?,?,'running',?,?,?,?,?)").run(id,"1","2026-11-18","now","now","cipher",Date.now()-100);
    assert.equal((await call(env,`/api/sharesight/runs/${id}/step`,{})).status,401);
    raw.prepare("UPDATE sharesight_runs SET token_cipher='cipher',token_expires=?,locked_until=? WHERE id=?").run(Date.now()+300000,Date.now()+300000,id);
    assert.equal((await call(env,`/api/sharesight/runs/${id}/step`,{})).status,409);
  } finally {globalThis.fetch=original;raw.close();}
});
