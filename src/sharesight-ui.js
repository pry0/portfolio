let info = {run:null,counts:[],jobs:[],limitations:[]}, rows = [], next = null, kind = "", running = false, working = false;
const escape = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const pretty = v => String(v).replaceAll("_"," ");
export async function loadSharesight(request) {info=await request("/api/sharesight/status");}
export function sharesightView() {
  const run=info.run, done=info.jobs.filter(j=>j.status==="done").length, gaps=info.jobs.filter(j=>j.status==="gap"), pending=info.jobs.filter(j=>j.status==="pending").length;
  return `<section class="panel"><div class="panel-head"><h2>Move your Sharesight history</h2><span class="pill ${gaps.length?"amber":"gray"}">${run?escape(pretty(run.status)):"Not connected"}</span></div><div class="panel-body"><p>Copy every available account separately, including sold investments, cash, income, custom prices, corporate-action records and attached documents. The source account is read only throughout the transfer.</p>${!run?`<button class="button primary" data-action="sharesight-connect">Connect existing API application ↗</button>`:`<p>Snapshot through <strong>${escape(run.as_of)}</strong>. ${done} endpoints copied · ${pending} waiting · ${gaps.length} need attention.</p><div class="controls"><button class="button primary" data-action="sharesight-${running?"pause":"run"}" ${(!pending&&!running)||(working&&!running)?"disabled":""}>${working&&!running?"Pausing…":running?"Pause after this record":"Continue transfer"}</button><button class="button" data-action="sharesight-connect" ${working||!pending?"disabled":""}>Reconnect to this snapshot</button><button class="button" data-action="sharesight-new" ${working?"disabled":""}>New snapshot</button><button class="button" data-action="sharesight-export" ${run.status!=="awaiting_reconciliation"?"disabled":""}>↓ Download complete API archive</button></div>`}<p class="fine">Client ID and secret are used once to obtain a temporary token. They are never stored. The token is encrypted, expires after at most 30 minutes and is discarded when the transfer finishes. Keep this page open while the transfer runs; you can reconnect and resume later.</p></div></section>
    ${run?`<section class="stats">${[["Source records",info.counts.reduce((n,r)=>n+r.count,0)],["Original responses",info.coverage?.count||0],["Stored data",((info.coverage?.bytes||0)/1048576).toFixed(2)+" MB"],["Endpoint gaps",gaps.length]].map(([label,value])=>`<div class="stat"><label>${label}</label><strong>${escape(value)}</strong></div>`).join("")}</section><section class="panel"><div class="panel-head"><h2>What has been copied</h2><small>Source records; reconciliation pending</small></div><div class="table-wrap"><table><thead><tr><th>RECORD TYPE</th><th>COUNT</th><th>EARLIEST</th><th>LATEST</th></tr></thead><tbody>${info.counts.map(c=>`<tr><td><button class="button ghost small" data-ss-kind="${escape(c.kind)}">${escape(pretty(c.kind))} ↗</button></td><td>${c.count}</td><td>${escape(c.first_date||"—")}</td><td>${escape(c.last_date||"—")}</td></tr>`).join("")||'<tr><td colspan="4">No source records copied yet.</td></tr>'}</tbody></table></div></section>`:""}
    ${gaps.length?`<section class="panel"><div class="panel-head"><h2>Missing or incomplete exports</h2><span class="pill amber">${gaps.length}</span></div><div class="table-wrap"><table><thead><tr><th>ENDPOINT</th><th>ISSUE</th><th>ACTION</th></tr></thead><tbody>${gaps.map(j=>`<tr><td class="row-title">${escape(pretty(j.category))}<span class="subtext">${escape(j.path)}</span></td><td class="row-title">${escape(j.message)}</td><td><button class="button small" data-ss-retry="${escape(j.id)}" ${working?"disabled":""}>Retry</button>${j.has_source?` <a class="button small" href="/api/sharesight/responses/${escape(j.id)}">Original ↓</a>`:""}</td></tr>`).join("")}</tbody></table></div></section>`:""}
    ${rows.length?`<section class="panel"><div class="panel-head"><h2>${escape(pretty(kind))} archive</h2><small>Original confirmation states retained</small></div><div class="table-wrap"><table><thead><tr><th>DATE</th><th>RECORD</th><th>SOURCE STATE</th><th>DETAILS</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escape(r.occurred_on||"—")}</td><td>${escape(r.label)}<span class="subtext">Source ID ${escape(r.source_id||"not assigned")}${r.portfolio_id?" · Portfolio "+escape(r.portfolio_id):""}</span></td><td>${escape(r.source_state||"—")}</td><td><button class="button small" data-ss-record="${escape(r.id)}">View all fields</button> <a class="button small" href="/api/sharesight/responses/${escape(r.response_id)}">Original ↓</a></td></tr>`).join("")}</tbody></table></div>${next?'<div class="panel-body"><button class="button" data-action="sharesight-next">Next 100 records →</button></div>':""}</section>`:""}
    <section class="panel"><div class="panel-head"><h2>Before switching off Sharesight</h2></div><div class="panel-body"><p>The transfer preserves evidence. It does not yet reproduce holdings, performance or tax calculations. Check every portfolio, closed holding, income total, cash balance and document count against Sharesight before relying on the new system.</p><ul>${info.limitations.map(s=>`<li>${escape(s)}</li>`).join("")}</ul><p class="fine">A completed API archive can still contain gaps listed above. The archive includes a manifest and every saved response; it is separate from the CSV records export.</p></div></section>`;
}
async function browse(request,render,after="") {
  const result=await request(`/api/sharesight/records?run=${encodeURIComponent(info.run.id)}&kind=${encodeURIComponent(kind)}&after=${encodeURIComponent(after)}`);
  rows=result.records;next=result.next;render();
}
async function transfer({request,render,toast}) {
  if(working || !info.run) return;
  running=true;working=true;render();
  try {
    while(running) {
      const result=await request(`/api/sharesight/runs/${info.run.id}/step`,{});
      await loadSharesight(request);render();
      if(result.status==="awaiting_reconciliation") {toast("API transfer finished. Review gaps and reconcile the snapshot.");break;}
      const delay=result.status==="waiting"?Math.max(1000,Math.min(30000,result.retryAt-Date.now())):400;
      await new Promise(resolve=>setTimeout(resolve,delay));
    }
  } catch(error) {toast(error.message);await loadSharesight(request);}
  finally {running=false;working=false;render();}
}
async function exportArchive(request,toast) {
  const parts=[];let cursor={phase:"jobs",after:0}, bytes=0;
  while(cursor) {
    const page=await request(`/api/sharesight/runs/${info.run.id}/export?phase=${cursor.phase}&after=${cursor.after}`);
    const records=[...(page.manifest?[{type:"manifest",...page.manifest}]:[]),...page.rows.map(data=>({type:page.section,data}))];
    const part=records.map(r=>JSON.stringify(r)+"\n").join("");bytes+=new TextEncoder().encode(part).length;
    if(bytes>128*1024*1024) throw Error("This archive exceeds the browser's 128 MB download limit. Original responses remain downloadable individually; use a paginated export client for a full backup.");
    parts.push(part);cursor=page.next;
  }
  parts.push(JSON.stringify({type:"end",runId:info.run.id,exportedAt:new Date().toISOString()})+"\n");
  const url=URL.createObjectURL(new Blob(parts,{type:"application/x-ndjson"})), a=document.createElement("a");
  a.href=url;a.download=`sharesight-${info.run.as_of}-${info.run.id}.ndjson`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  toast("Complete API archive prepared. Keep it with your original records.");
}
export async function sharesightClick(target,ctx) {
  const {request,render,toast,dialog}=ctx, action=target.dataset.action;
  if(target.dataset.ssKind) {kind=target.dataset.ssKind;await browse(request,render);return true;}
  if(target.dataset.ssRecord) {
    const r=await request(`/api/sharesight/records/${target.dataset.ssRecord}`);
    dialog("Original Sharesight fields",`<pre class="source-json">${escape(JSON.stringify(JSON.parse(r.raw_json),null,2))}</pre><p class="fine">Numeric values are shown as exact source strings. Download the original response for the unchanged API bytes.</p>`,async()=>{},"Close");return true;
  }
  if(target.dataset.ssRetry) {
    await request(`/api/sharesight/runs/${info.run.id}/retry`,{jobId:target.dataset.ssRetry});
    await loadSharesight(request);render();toast("Endpoint queued. Reconnect if the temporary token has expired.");return true;
  }
  if(!action?.startsWith("sharesight-")) return false;
  if(action==="sharesight-connect" || action==="sharesight-new") {
    const resume=action!=="sharesight-new"?info.run?.id:null;
    dialog(resume?"Resume the Sharesight transfer":"Connect Sharesight for migration",`<p>Use your existing, already authorised Sharesight API application. You can find it under <a href="https://portfolio.sharesight.com/oauth_consumers" target="_blank" rel="noreferrer">Account → Sharesight API</a>.</p><label class="field">Client ID<input name="clientId" required autocomplete="off" maxlength="512"></label><label class="field">Client secret<input name="clientSecret" type="password" required autocomplete="off" maxlength="4096"></label><p class="fine">Only the token request is a POST to Sharesight. Every portfolio request is a GET. The app will not change or confirm any Sharesight records. The existing crypto-price script is left connected.</p>`,async b=>{
      try {
        await request("/api/sharesight/connect",{...b,...(resume?{runId:resume}:{})});
        await loadSharesight(request);rows=[];next=null;
      } finally {document.querySelectorAll('#dialog-body input').forEach(input=>input.value="");}
    },resume?"Reconnect":"Connect and prepare transfer");
  } else if(action==="sharesight-run") await transfer(ctx);
  else if(action==="sharesight-pause") {running=false;render();toast("Pausing after the current endpoint.");}
  else if(action==="sharesight-next") await browse(request,render,next);
  else if(action==="sharesight-export") {
    target.disabled=true;
    try {await exportArchive(request,toast);} finally {target.disabled=false;}
  }
  return true;
}
