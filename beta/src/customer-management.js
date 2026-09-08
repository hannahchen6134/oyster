import { track } from './db.js';
export async function touchCustomer(db, actor, channel, now=new Date().toISOString()) {
 if (!actor) return;
 await db.prepare(`INSERT INTO app_kv(k,v,updatedAt) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updatedAt=excluded.updatedAt WHERE excluded.updatedAt > app_kv.updatedAt`)
 .bind('customerActivity:'+actor,JSON.stringify({at:now,channel}),now).run();
}
export async function auditExport(db,owner,id,format,count,scope,now=new Date().toISOString()) {
 await db.prepare('INSERT INTO app_kv(k,v,updatedAt) VALUES (?,?,?)').bind('customerExport:'+id,JSON.stringify({owner,format,count,scope,generatedAt:now}),now).run();
}
export async function markDownload(db,owner,id,now=new Date().toISOString(),verifiedActor=true) {
 const key='customerExport:'+id;
 // Atomic JSON update preserves creation metadata and first request time.
 const result=await db.prepare(`UPDATE app_kv SET v=json_set(v,'$.requestedAt',COALESCE(json_extract(v,'$.requestedAt'),?)),updatedAt=? WHERE k=? AND json_extract(v,'$.owner')=?`).bind(now,now,key,owner).run();
 if(result.meta?.changes && verifiedActor) { await touchCustomer(db,owner,'download',now); await track(db,owner,'data_download'); }
 return !!result.meta?.changes;
}
export function retentionStatus(lastActivity,now=Date.now()) {
 if(!lastActivity || !Number.isFinite(Date.parse(lastActivity))) return {key:'unknown',label:'尚未追蹤使用時間'};
 const d=new Date(lastActivity); const year=d.getUTCFullYear()+1; const month=d.getUTCMonth();
 d.setUTCFullYear(year); if(d.getUTCMonth()!==month)d.setUTCDate(0);
 return now>=d.getTime()?{key:'due',label:'已滿一年・待通知（未啟用清除）'}:{key:'active',label:'使用中',noticeDue:d.toISOString()};
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>s?esc(new Date(s).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})):'未追蹤';
export async function customerPanel(db) {
 const {results:users}=await db.prepare(`SELECT u.lineUserId,u.displayName,u.createdAt,u.betaAccess,
 (SELECT MIN(l.createdAt) FROM logs l WHERE l.lineUserId=u.lineUserId AND l.source IN ('line','web')) firstRecord,
 (SELECT MAX(l.createdAt) FROM logs l WHERE l.lineUserId=u.lineUserId AND l.source IN ('line','web')) lastRecord,
 (SELECT COUNT(*) FROM pets p WHERE p.ownerLineUserId=u.lineUserId AND p.isDeleted=0) cats,
 (SELECT COUNT(*) FROM logs l WHERE l.lineUserId=u.lineUserId AND l.isDeleted=0) records
 FROM users u ORDER BY u.createdAt DESC`).all();
 const {results:kv}=await db.prepare("SELECT k,v FROM app_kv WHERE k LIKE 'customerActivity:%' OR k LIKE 'customerExport:%'").all();
 const map=new Map((kv||[]).map(r=>[r.k,JSON.parse(r.v)]));
 const journeys=new Map();
 try {
  const {results}=await db.prepare(`SELECT lineUserId,event,createdAt FROM
   (SELECT lineUserId,event,createdAt,id,ROW_NUMBER() OVER(PARTITION BY lineUserId ORDER BY createdAt DESC,id DESC) n FROM events WHERE createdAt>=?)
   WHERE n<=200 ORDER BY createdAt DESC,id DESC`).bind(new Date(Date.now()-30*86400000).toISOString()).all();
  for(const user of users||[]) journeys.set(user.lineUserId,buildJourney((results||[]).filter(e=>e.lineUserId===user.lineUserId)));
 } catch { for(const user of users||[]) journeys.set(user.lineUserId,{recent:[],common:[],unavailable:true}); }
 const exports=[...map.entries()].filter(([k])=>k.startsWith('customerExport:')).map(([,v])=>v);
 return `<section aria-label="客戶使用與資料管理"><div class="customer-tools"><label>搜尋客戶<input id="customerSearch" type="search" placeholder="輸入姓名" autocomplete="off"></label><label>篩選<select id="customerFilter"><option value="all">全部客戶</option><option value="recent">近 7 天有記錄</option><option value="new">尚未開始記錄</option><option value="due">待通知</option></select></label></div><p id="customerCount" class="muted" aria-live="polite"></p>${(users||[]).map(u=>{
 const journey=journeys.get(u.lineUserId);
 const activity=map.get('customerActivity:'+u.lineUserId); const status=retentionStatus(activity?.at);
 const history=exports.filter(e=>e.owner===u.lineUserId).sort((a,b)=>b.generatedAt.localeCompare(a.generatedAt));
 const on=Number(u.betaAccess)===1;
 const recent=u.lastRecord && Date.parse(u.lastRecord)>=Date.now()-7*86400000;
 return `<details class="customer" data-name="${esc(u.displayName)}" data-new="${!u.firstRecord}" data-recent="${!!recent}" data-status="${status.key}"><summary><span class="customer-head"><strong>${esc(u.displayName)||'未命名'}</strong><span class="access-badge">${on?'已開通':'已停用'}</span></span><span class="customer-meta">${u.cats} 隻貓 · ${u.records} 筆紀錄</span><span class="customer-last">${activity?.at?'最近使用：'+date(activity.at):u.lastRecord?'最後記錄：'+date(u.lastRecord):'尚無使用時間紀錄'}</span><span class="detail-hint">查看詳情 <span class="chevron">⌄</span></span></summary><div class="customer-body"><section><h3>使用概況</h3><dl><dt>帳戶建立</dt><dd>${date(u.createdAt)}</dd><dt>首次記錄</dt><dd>${date(u.firstRecord)}</dd><dt>最後記錄</dt><dd>${date(u.lastRecord)}</dd></dl></section><section><h3>操作路徑</h3><p class="muted">近 30 天，最多 200 次已收到的操作</p>${journey.recent.length?`<ol class="timeline">${journey.recent.slice().reverse().map(e=>`<li><time>${date(e.createdAt)}</time><span>${esc(e.label)}</span></li>`).join('')}</ol>`:'<p class="empty-note">尚無可辨識的操作紀錄</p>'}<h4>常見接續操作</h4>${journey.common.length?`<ul class="path-list">${journey.common.map(e=>`<li>${esc(e.path)}<small>${e.count} 次</small></li>`).join('')}</ul>`:'<p class="empty-note">資料不足，暫不判斷常見路徑</p>'}</section><section><h3>資料下載歷程</h3>${history.length?history.map(e=>`<article class="export-entry"><strong>${esc(e.format)} · ${esc(e.scope)}</strong><span>${Number(e.count)||0} 筆紀錄</span><dl><dt>產生時間</dt><dd>${date(e.generatedAt)}</dd><dt>下載請求</dt><dd>${date(e.requestedAt)}</dd></dl></article>`).join(''):'<p class="empty-note">尚無下載追蹤紀錄</p>'}<h4>保存狀態</h4><p>${status.label}</p>${status.noticeDue?`<p class="muted">預計滿一年：${date(status.noticeDue)}</p>`:''}</section><section class="account-action"><h3>帳戶權限</h3><p class="muted">停用會限制使用，既有資料仍保留。</p><a class="btn ${on?'btn-off':'btn-on'}" data-access-action href="/admin/testers?user=${encodeURIComponent(u.lineUserId)}&access=${on?0:1}">${on?'停用此帳戶':'開通此帳戶'}</a></section></div></details>`;
 }).join('')}<p id="customerEmpty" class="empty-note" hidden>沒有符合條件的客戶，請更換搜尋或篩選。</p><details class="method-note"><summary>資料與統計說明</summary><p>下載請求不代表檔案已存到手機。歷史下載不回推；保存通知及清除尚未啟用。操作路徑只連接相隔 30 分鐘內的已收到事件，不代表完整 LINE 點擊過程。</p></details><script>
const search=document.getElementById('customerSearch'),filter=document.getElementById('customerFilter');
function filterCustomers(){let count=0;document.querySelectorAll('.customer').forEach(e=>{const match=e.dataset.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())&&(filter.value==='all'||filter.value==='new'&&e.dataset.new==='true'||filter.value==='recent'&&e.dataset.recent==='true'||filter.value==='due'&&e.dataset.status==='due');e.hidden=!match;if(match)count++;});document.getElementById('customerCount').textContent=count+' 位客戶';document.getElementById('customerEmpty').hidden=count>0;}
search.addEventListener('input',filterCustomers);filter.addEventListener('change',filterCustomers);filterCustomers();
document.querySelectorAll('[data-access-action]').forEach(a=>a.addEventListener('click',e=>{if(!confirm('確定要'+a.textContent+'？'))e.preventDefault();}));
</script></section>`;
}

const PATH_LABELS={follow:'加入 LINE',record:'完成紀錄',menu_record:'開啟記一筆',menu_review:'查看近期紀錄',howtype:'查看怎麼記',website_open:'開啟管家',calendar_open:'查看月曆',review_open:'查看回顧',export:'申請 CSV',data_download:'下載請求',care_open:'查看共同照護',report_save:'儲存摘要',report_send_line:'摘要傳到 LINE'};
export function buildJourney(events) {
 const rows=[...events].filter(e=>PATH_LABELS[e.event]).reverse().map(e=>({...e,label:PATH_LABELS[e.event]}));
 const pairs=new Map();
 for(let i=1;i<rows.length;i++) {
  const gap=Date.parse(rows[i].createdAt)-Date.parse(rows[i-1].createdAt);
  if(gap<0||gap>30*60000)continue;
  const path=rows[i-1].label+' → '+rows[i].label;
  pairs.set(path,(pairs.get(path)||0)+1);
 }
 return {recent:rows.slice(-8),common:[...pairs].map(([path,count])=>({path,count})).sort((a,b)=>b.count-a.count).slice(0,3)};
}
