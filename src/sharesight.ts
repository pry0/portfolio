import { exactJSON, inspectResponse, initialJobs, LIMITATIONS, object, safePath, sourceId, string, type JobPlan, type IndexedRecord } from "./sharesight-model.ts";
import { sha256 } from "./imports.js";
const MAX_BYTES = 4 * 1024 * 1024;
const now = () => new Date().toISOString();
type Run = {id:string; source_user_id:string; status:string; as_of:string; token_cipher:string|null; token_expires:number|null};
type Job = {id:string; path:string; category:string; portfolio_id:string|null; attempts:number};
class MigrationError extends Error {
  status: number;
  constructor(message:string,status=400) { super(message); this.status=status; }
}
const json = (value:unknown,status=200) => Response.json(value,{status});
const base64 = (bytes:Uint8Array) => {
  let result="";
  for(let i=0;i<bytes.length;i+=16000) result+=String.fromCharCode(...bytes.subarray(i,i+16000));
  return btoa(result);
};
const bytes64 = (s:string) => Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function key(env:Env) {
  if(!/^[a-f0-9]{64}$/.test(env.MIGRATION_KEY || "")) throw new MigrationError("The migration service needs its encryption key configured.",503);
  return crypto.subtle.importKey("raw",Uint8Array.from(env.MIGRATION_KEY.match(/../g)!, h=>parseInt(h,16)),"AES-GCM",false,["encrypt","decrypt"]);
}
export async function sealToken(env:Env, token:string,runId:string) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const value=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:new TextEncoder().encode(runId)},await key(env),new TextEncoder().encode(token));
  return base64(iv)+"."+base64(new Uint8Array(value));
}
async function openToken(env:Env,value:string,runId:string) {
  const [iv,data]=value.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes64(iv),additionalData:new TextEncoder().encode(runId)},await key(env),bytes64(data)));
}
export async function boundedBytes(response:Response,limit=MAX_BYTES) {
  if(Number(response.headers.get("Content-Length"))>limit) {await response.body?.cancel();throw new MigrationError("Source response exceeds 4 MB; a separate export is required.");}
  const reader=response.body?.getReader(), chunks:Uint8Array[]=[];
  let size=0;
  if(reader) while(true) {
    const {value,done}=await reader.read(); if(done) break;
    size+=value.length;
    if(size>limit) {await reader.cancel();throw new MigrationError("Source response exceeds 4 MB; a separate export is required.");}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size); let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
  return bytes;
}
async function input(request:Request) {
  if(!request.headers.get("Content-Type")?.startsWith("application/json")) throw new MigrationError("Use JSON.");
  try {return object(JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(await boundedBytes(new Response(request.body),16000))));}
  catch {throw new MigrationError("Invalid migration request.");}
}
async function sourceFetch(path:string,token:string):Promise<Response> {
  return fetch("https://api.sharesight.com"+safePath(path),{
    method:"GET",headers:{Authorization:`Bearer ${token}`,Accept:"application/json"},redirect:"manual",signal:AbortSignal.timeout(25000),
  });
}
// Signed document redirects may go to Sharesight's S3 storage. Never forward
// the bearer token to a redirect, and never follow arbitrary response URLs.
async function documentRedirect(response:Response):Promise<Response> {
  for(let i=0;i<3 && [301,302,303,307,308].includes(response.status);i++) {
    const location=response.headers.get("Location");
    await response.body?.cancel();
    if(!location) throw new MigrationError("Document redirect has no location.");
    const u=new URL(location,"https://api.sharesight.com");
    if(u.protocol!=="https:" || u.username || u.password || (u.port && u.port!=="443") ||
       !(u.hostname.endsWith(".sharesight.com") || u.hostname.endsWith(".amazonaws.com")))
      throw new MigrationError("Document needs a separate download from Sharesight.");
    response=await fetch(u,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(25000)});
  }
  return response;
}
function enqueue(db:D1Database,runId:string,job:JobPlan) {
  return db.prepare("INSERT OR IGNORE INTO sharesight_jobs(id,run_id,path,category,portfolio_id,created_at) VALUES(?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),runId,safePath(job.path),job.category,job.portfolioId,now());
}
async function connect(request:Request,env:Env) {
  await key(env);
  const b=await input(request), clientId=string(b.clientId).trim(), clientSecret=string(b.clientSecret).trim();
  if(!clientId || !clientSecret || clientId.length>512 || clientSecret.length>4096) throw new MigrationError("Enter your existing Sharesight API client ID and secret.");
  const runId=string(b.runId) || crypto.randomUUID();
  if(!/^[a-f0-9-]{36}$/.test(runId)) throw new MigrationError("Invalid migration ID.");
  const existing=await env.DB.prepare("SELECT * FROM sharesight_runs WHERE id=?").bind(runId).first<Run>();
  if(b.runId && !existing) throw new MigrationError("Migration not found.",404);
  if(existing && !["running","paused","awaiting_reconciliation"].includes(existing.status)) throw new MigrationError("This migration cannot be resumed.");
  if(existing && !(await env.DB.prepare("SELECT id FROM sharesight_jobs WHERE run_id=? AND status='pending' LIMIT 1").bind(runId).first()))
    throw new MigrationError("No endpoints are waiting. Queue a failed endpoint for retry, or start a new snapshot.");
  const tokenResponse=await fetch("https://portfolio.sharesight.com/oauth2/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},
    body:new URLSearchParams({grant_type:"client_credentials",client_id:clientId,client_secret:clientSecret}),
    redirect:"error",signal:AbortSignal.timeout(25000),
  });
  if(!tokenResponse.ok) {
    await tokenResponse.body?.cancel();
    throw new MigrationError(`Sharesight did not authorise this existing API application (HTTP ${tokenResponse.status}). Check that it is linked to your own account.`,401);
  }
  const tokenData=object(JSON.parse(new TextDecoder().decode(await boundedBytes(tokenResponse,32000))));
  const token=string(tokenData.access_token);
  if(!token || token.length>8000) throw new MigrationError("Sharesight did not return an access token.",502);
  const who=await sourceFetch("/api/v2/my_user.json",token);
  if(!who.ok) {await who.body?.cancel();throw new MigrationError(`Sharesight API access failed (HTTP ${who.status}).`,401);}
  const userId=sourceId(object(exactJSON(new TextDecoder().decode(await boundedBytes(who))).user).id);
  if(!userId) throw new MigrationError("Could not verify the Sharesight account.",502);
  if(existing && existing.source_user_id!==userId) throw new MigrationError("These credentials belong to a different Sharesight account.",409);
  const cipher=await sealToken(env,token,runId);
  const expires=Date.now()+Math.min(Math.max(Number(tokenData.expires_in)||1800,60),1800)*1000-30000;
  if(existing) {
    const locked=await env.DB.prepare("SELECT locked_until FROM sharesight_runs WHERE id=?").bind(runId).first<{locked_until:number}>();
    if((locked?.locked_until??0)>Date.now()) throw new MigrationError("A transfer is in progress. Try reconnecting shortly.",409);
    await env.DB.prepare("UPDATE sharesight_runs SET token_cipher=?,token_expires=?,status='running',updated_at=? WHERE id=?")
      .bind(cipher,expires,now(),runId).run();
  } else {
    const time=now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sharesight_runs(id,source_user_id,status,as_of,created_at,updated_at,token_cipher,token_expires) VALUES(?,?,'running',?,?,?,?,?)")
        .bind(runId,userId,time.slice(0,10),time,time,cipher,expires),
      ...initialJobs().map(j=>enqueue(env.DB,runId,j)),
    ]);
  }
  return json({id:runId,status:"running",expiresAt:new Date(expires).toISOString()},existing?200:201);
}
function recordStatements(db:D1Database,runId:string,responseId:string,records:IndexedRecord[]) {
  const statements:D1PreparedStatement[]=[];
  // JSON1 bulk inserts keep the number of D1 queries bounded for large lists.
  let group:Record<string,unknown>[]=[], length=0;
  const flush=()=> {
    if(!group.length) return;
    statements.push(db.prepare(`INSERT INTO sharesight_records(id,run_id,source_key,source_id,kind,portfolio_id,holding_id,occurred_on,label,source_state,raw_json,response_id)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.sourceKey'),json_extract(value,'$.sourceId'),json_extract(value,'$.kind'),json_extract(value,'$.portfolioId'),json_extract(value,'$.holdingId'),json_extract(value,'$.occurredOn'),json_extract(value,'$.label'),json_extract(value,'$.sourceState'),json_extract(value,'$.rawJSON'),? FROM json_each(?) WHERE 1
      ON CONFLICT(run_id,source_key) DO UPDATE SET raw_json=excluded.raw_json,response_id=excluded.response_id,source_state=excluded.source_state,label=excluded.label,occurred_on=excluded.occurred_on`)
      .bind(runId,responseId,JSON.stringify(group)));
    group=[];length=0;
  };
  for(const record of records) {
    const {raw,...rest}=record, item={...rest,id:crypto.randomUUID(),rawJSON:JSON.stringify(raw)}, size=JSON.stringify(item).length;
    if(size>700000) throw new MigrationError("An individual record is too large to index; its source response is preserved.");
    if(length+size>700000) flush();
    group.push(item);length+=size;
    if(record.kind==="portfolio" && sourceId(raw.id) && string(raw.name) && /^[A-Z]{3}$/.test(string(raw.currency_code))) {
      statements.push(db.prepare("INSERT INTO portfolios(id,name,kind,currency,created_at) VALUES(?,?,'other',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,currency=excluded.currency")
        .bind("ss-"+raw.id,string(raw.name).slice(0,200),raw.currency_code,now()));
    }
  }
  flush(); return statements;
}
async function archive(env:Env,run:Run,job:Job,response:Response,bytes:Uint8Array) {
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(v=>v.toString(16).padStart(2,"0")).join("");
  const encoded=base64(bytes), headers:Record<string,string>={};
  for(const name of ["content-type","content-disposition","x-holdinglimit-limit","x-holdinglimit-total","x-holdinglimit-reason"]) {
    const value=response.headers.get(name);if(value) headers[name]=value;
  }
  const statements=[env.DB.prepare("INSERT OR REPLACE INTO sharesight_responses VALUES(?,?,?,?,?,?,?)")
    .bind(job.id,run.id,hash,bytes.length,response.headers.get("Content-Type")||"application/octet-stream",JSON.stringify(headers),now()),
    env.DB.prepare("DELETE FROM sharesight_chunks WHERE response_id=?").bind(job.id)];
  for(let i=0;i<encoded.length;i+=240000) statements.push(env.DB.prepare("INSERT INTO sharesight_chunks VALUES(?,?,?)").bind(job.id,i/240000,encoded.slice(i,i+240000)));
  // Source bytes are saved before indexing. If schema/record extraction fails,
  // keep the response and an explicit gap instead of dropping information.
  await env.DB.batch(statements);
  let message:string|null=null, records:IndexedRecord[]=[], jobs:JobPlan[]=[];
  if(job.category!=="document") {
    try {
      const data=exactJSON(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes));
      const result=await inspectResponse({path:job.path,category:job.category,portfolioId:job.portfolio_id},data,run.as_of,sha256);
      records=result.records;jobs=result.jobs;
      if(result.warnings.length) message=[...new Set(result.warnings)].join(" ");
    } catch(error) {message=error instanceof Error?error.message:"Response could not be indexed.";}
  }
  if(headers["x-holdinglimit-reason"] || (headers["x-holdinglimit-limit"] && Number(headers["x-holdinglimit-total"])>Number(headers["x-holdinglimit-limit"])))
    message="Sharesight applied a holding limit. This response is incomplete.";
  const unique=new Map(jobs.map(j=>[safePath(j.path),j]));
  // A repeated cursor must not silently terminate pagination.
  for(const j of unique.values()) if(new URL(j.path,"https://api.sharesight.com").searchParams.has("page")) {
    if(await env.DB.prepare("SELECT id FROM sharesight_jobs WHERE run_id=? AND path=?").bind(run.id,safePath(j.path)).first())
      message="Sharesight repeated a pagination page. Check the archived responses before continuing.";
  }
  try {
    const inserts=recordStatements(env.DB,run.id,job.id,records);
    // Enqueue in JSON1 batches: many sold holdings may be discovered in one report.
    const plans=[...unique.values()].map(j=>({id:crypto.randomUUID(),path:safePath(j.path),category:j.category,portfolioId:j.portfolioId}));
    for(let i=0;i<plans.length;i+=100) inserts.push(env.DB.prepare(`INSERT OR IGNORE INTO sharesight_jobs(id,run_id,path,category,portfolio_id,created_at)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.path'),json_extract(value,'$.category'),json_extract(value,'$.portfolioId'),? FROM json_each(?)`)
      .bind(run.id,now(),JSON.stringify(plans.slice(i,i+100))));
    inserts.push(env.DB.prepare("UPDATE sharesight_jobs SET status=?,http_status=?,message=?,record_count=? WHERE id=?")
      .bind(message?"gap":"done",response.status,message,records.length,job.id));
    await env.DB.batch(inserts);
  } catch {
    await env.DB.prepare("UPDATE sharesight_jobs SET status='gap',http_status=?,message='Source bytes saved, but indexing failed. Retry this endpoint before reconciliation.' WHERE id=?").bind(response.status,job.id).run();
  }
}
async function step(env:Env,id:string) {
  const run=await env.DB.prepare("SELECT * FROM sharesight_runs WHERE id=?").bind(id).first<Run>();
  if(!run) throw new MigrationError("Migration not found.",404);
  if(!run.token_cipher || (run.token_expires??0)<=Date.now()) {
    if(run.status==="awaiting_reconciliation") return json({status:run.status});
    await env.DB.prepare("UPDATE sharesight_runs SET status='paused',token_cipher=NULL,token_expires=NULL WHERE id=?").bind(id).run();
    throw new MigrationError("The temporary Sharesight token expired. Reconnect to resume this migration.",401);
  }
  const owner=crypto.randomUUID();
  const lock=await env.DB.prepare("UPDATE sharesight_runs SET lock_owner=?,locked_until=? WHERE id=? AND locked_until<?")
    .bind(owner,Date.now()+180000,id,Date.now()).run();
  if(!lock.meta.changes) return json({status:"busy"},409);
  let job:Job|null=null;
  try {
    job=await env.DB.prepare("SELECT * FROM sharesight_jobs WHERE run_id=? AND status='pending' AND retry_after<=? ORDER BY created_at,rowid LIMIT 1")
      .bind(id,Date.now()).first<Job>();
    if(!job) {
      const waiting=await env.DB.prepare("SELECT COUNT(*) n,MIN(retry_after) next FROM sharesight_jobs WHERE run_id=? AND status='pending'").bind(id).first<{n:number;next:number}>();
      if(waiting?.n) return json({status:"waiting",retryAt:waiting.next});
      await env.DB.prepare("UPDATE sharesight_runs SET status='awaiting_reconciliation',token_cipher=NULL,token_expires=NULL,updated_at=? WHERE id=?").bind(now(),id).run();
      return json({status:"awaiting_reconciliation"});
    }
    await env.DB.prepare("UPDATE sharesight_jobs SET attempts=attempts+1 WHERE id=?").bind(job.id).run();
    let response=await sourceFetch(job.path,await openToken(env,run.token_cipher,id));
    if(job.category==="document") response=await documentRedirect(response);
    if(response.status===401) {
      await response.body?.cancel();
      await env.DB.prepare("UPDATE sharesight_runs SET status='paused',token_cipher=NULL,token_expires=NULL WHERE id=?").bind(id).run();
      throw new MigrationError("Sharesight rejected the temporary token. Reconnect to resume.",401);
    }
    if(!response.ok) {
      const status=response.status, retry=Number(response.headers.get("Retry-After"));
      await response.body?.cancel();
      const temporary=status===429 || status>=500;
      await env.DB.prepare("UPDATE sharesight_jobs SET status=?,http_status=?,message=?,retry_after=? WHERE id=?")
        .bind(temporary && job.attempts<2?"pending":"gap",status,`Sharesight returned HTTP ${status}; this endpoint has not been copied.`,Date.now()+Math.max(30000,Math.min(300000,(retry||30)*1000)),job.id).run();
    } else await archive(env,run,job,response,await boundedBytes(response));
    await env.DB.prepare("UPDATE sharesight_runs SET updated_at=? WHERE id=?").bind(now(),id).run();
    return json({status:"running",category:job.category});
  } catch(error) {
    if(error instanceof MigrationError && error.status===401) throw error;
    if(job) {
      await env.DB.prepare("UPDATE sharesight_jobs SET status='gap',message=? WHERE id=?")
        .bind(error instanceof MigrationError?error.message:"Transfer interrupted. Retry this endpoint; no completion was assumed.",job.id).run();
      return json({status:"running",gap:true});
    }
    throw error;
  } finally {
    await env.DB.prepare("UPDATE sharesight_runs SET locked_until=0,lock_owner=NULL WHERE id=? AND lock_owner=?").bind(id,owner).run();
  }
}
async function status(env:Env) {
  const run=await env.DB.prepare("SELECT id,status,as_of,created_at,updated_at,token_expires FROM sharesight_runs ORDER BY created_at DESC LIMIT 1").first();
  if(!run) return {run:null,counts:[],jobs:[],limitations:LIMITATIONS};
  const [counts,jobs,coverage]=await Promise.all([
    env.DB.prepare("SELECT kind,COUNT(*) count,MIN(occurred_on) first_date,MAX(occurred_on) last_date FROM sharesight_records WHERE run_id=? GROUP BY kind").bind(run.id).all(),
    env.DB.prepare("SELECT j.id,j.category,j.path,j.portfolio_id,j.status,j.attempts,j.http_status,j.message,j.record_count,(r.id IS NOT NULL) AS has_source FROM sharesight_jobs j LEFT JOIN sharesight_responses r ON r.id=j.id WHERE j.run_id=? ORDER BY j.rowid").bind(run.id).all(),
    env.DB.prepare("SELECT COUNT(*) count,SUM(byte_count) bytes FROM sharesight_responses WHERE run_id=?").bind(run.id).first(),
  ]);
  return {run,counts:counts.results,jobs:jobs.results,coverage,limitations:LIMITATIONS};
}
async function exportPage(env:Env,id:string,url:URL) {
  const run=await env.DB.prepare("SELECT id,status,as_of,created_at,updated_at FROM sharesight_runs WHERE id=?").bind(id).first();
  if(!run) throw new MigrationError("Migration not found.",404);
  if(run.status!=="awaiting_reconciliation") throw new MigrationError("Finish or pause the transfer before making a complete archive download.",409);
  const phase=url.searchParams.get("phase")||"jobs", after=Number(url.searchParams.get("after")||0);
  if(!Number.isSafeInteger(after)||after<0) throw new MigrationError("Invalid export cursor.");
  const tables:Record<string,string>={jobs:"sharesight_jobs",responses:"sharesight_responses",chunks:"sharesight_chunks",records:"sharesight_records"};
  if(!tables[phase]) throw new MigrationError("Invalid export section.");
  const condition=phase==="chunks"?"response_id IN (SELECT id FROM sharesight_responses WHERE run_id=?)":"run_id=?";
  const rows=await env.DB.prepare(`SELECT rowid AS export_rowid,* FROM ${tables[phase]} WHERE ${condition} AND rowid>? ORDER BY rowid LIMIT 26`).bind(id,after).all<{export_rowid:number}>();
  const page=rows.results.slice(0,25), nextPhase=Object.keys(tables)[Object.keys(tables).indexOf(phase)+1];
  const next=rows.results.length>25?{phase,after:page[24].export_rowid}:nextPhase?{phase:nextPhase,after:0}:null;
  return json({manifest:phase==="jobs"&&after===0?{format:"portfolio-sharesight-archive",version:1,run,limitations:LIMITATIONS}:null,section:phase,rows:page.map(({export_rowid,...data})=>data),next});
}
export async function sharesightAPI(request:Request,env:Env):Promise<Response> {
  const url=new URL(request.url), path=url.pathname;
  try {
    if(request.method!=="GET" && request.headers.get("Origin")!==url.origin) return json({error:"Request origin is not allowed."},403);
    if(path==="/api/sharesight/status" && request.method==="GET") return json(await status(env));
    if(path==="/api/sharesight/connect" && request.method==="POST") return await connect(request,env);
    const route=/^\/api\/sharesight\/runs\/([a-f0-9-]{36})\/(step|retry|export)$/.exec(path);
    if(route) {
      const [,id,action]=route;
      if(action==="export" && request.method==="GET") return await exportPage(env,id,url);
      if(action==="step" && request.method==="POST") return await step(env,id);
      if(action==="retry" && request.method==="POST") {
        const b=await input(request), jobId=string(b.jobId);
        if(!/^[a-f0-9-]{36}$/.test(jobId)) throw new MigrationError("Select an endpoint to retry.");
        const run=await env.DB.prepare("SELECT locked_until FROM sharesight_runs WHERE id=?").bind(id).first<{locked_until:number}>();
        if(!run) throw new MigrationError("Migration not found.",404);
        if(run.locked_until>Date.now()) throw new MigrationError("Wait for the current transfer to finish.",409);
        await env.DB.batch([
          env.DB.prepare("UPDATE sharesight_jobs SET status='pending',attempts=0,retry_after=0,message=NULL WHERE run_id=? AND id=? AND status='gap'").bind(id,jobId),
          env.DB.prepare("UPDATE sharesight_runs SET status='paused' WHERE id=?").bind(id),
        ]);
        return json({ok:true});
      }
    }
    if(path==="/api/sharesight/records" && request.method==="GET") {
      const runId=url.searchParams.get("run")??"", kind=url.searchParams.get("kind")??"", cursor=url.searchParams.get("after")??"";
      const rows=await env.DB.prepare("SELECT id,kind,portfolio_id,holding_id,occurred_on,label,source_state,source_id,response_id FROM sharesight_records WHERE run_id=? AND (?='' OR kind=?) AND id>? ORDER BY id LIMIT 101")
        .bind(runId,kind,kind,cursor).all<{id:string}>();
      return json({records:rows.results.slice(0,100),next:rows.results.length>100?rows.results[99].id:null});
    }
    const record=/^\/api\/sharesight\/records\/([a-f0-9-]{36})$/.exec(path);
    if(record && request.method==="GET") {
      const row=await env.DB.prepare("SELECT * FROM sharesight_records WHERE id=?").bind(record[1]).first();
      return row?json(row):json({error:"Record not found."},404);
    }
    const file=/^\/api\/sharesight\/responses\/([a-f0-9-]{36})$/.exec(path);
    if(file && request.method==="GET") {
      const metadata=await env.DB.prepare("SELECT content_type FROM sharesight_responses WHERE id=?").bind(file[1]).first<{content_type:string}>();
      if(!metadata) throw new MigrationError("Response not found.",404);
      const chunks=await env.DB.prepare("SELECT base64 FROM sharesight_chunks WHERE response_id=? ORDER BY chunk_index").bind(file[1]).all<{base64:string}>();
      return new Response(bytes64(chunks.results.map(c=>c.base64).join("")),{headers:{"Content-Type":"application/octet-stream","Content-Disposition":`attachment; filename="sharesight-${file[1]}.${metadata.content_type.includes("json")?"json":"bin"}"`}});
    }
    return json({error:"Migration endpoint not found."},404);
  } catch(error) {
    if(error instanceof MigrationError) return json({error:error.message},error.status);
    console.error(JSON.stringify({event:"sharesight_request_failed",path}));
    return json({error:"Migration request failed. Your saved source records remain intact; check the migration status before retrying."},500);
  }
}
