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
 const {results:users}=await db.prepare(`SELECT u.lineUserId,u.displayName,u.createdAt,
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
 return `<section><h2>客戶使用與資料管理</h2><p>下載請求不代表檔案已存到手機。歷史下載不回推；保存通知及清除尚未啟用。</p><label>篩選 <select id="customerFilter"><option value="all">全部客戶</option><option value="new">尚未開始記錄</option><option value="due">待通知</option></select></label>${(users||[]).map(u=>{
 const journey=journeys.get(u.lineUserId);
 const activity=map.get('customerActivity:'+u.lineUserId); const status=retentionStatus(activity?.at);
 const history=exports.filter(e=>e.owner===u.lineUserId).sort((a,b)=>b.generatedAt.localeCompare(a.generatedAt));
 return `<details class="customer" data-new="${!u.firstRecord}" data-status="${status.key}" style="overflow-wrap:anywhere;padding:16px 0;border-bottom:1px solid #ddd"><summary style="cursor:pointer;min-height:48px"><strong>${esc(u.displayName)||'未命名'}</strong> · ${u.cats} 隻貓 · ${u.records} 筆<br>最近使用：${date(activity?.at)} · ${status.label}</summary><p>帳戶建立：${date(u.createdAt)}<br>首次成功記錄：${date(u.firstRecord)}<br>最後記錄提交：${date(u.lastRecord)}<br>預計滿一年：${date(status.noticeDue)}</p><h3>使用路徑（近 30 天，最多 200 次已收到操作）</h3><p>最近操作：${journey.recent.map(e=>`${date(e.createdAt)} ${esc(e.label)}`).join(" → ")||"尚無可辨識事件"}</p><p>常見接續操作：${journey.common.map(e=>`${esc(e.path)}（${e.count} 次）`).join("；")||"資料不足"}</p><p>僅計算相隔 30 分鐘內的接續操作；不代表完整 LINE 點擊過程。</p><h3>資料下載歷程</h3>${history.length?history.map(e=>`<p>${esc(e.format)} · ${esc(e.scope)} · ${Number(e.count)||0} 筆<br>產生：${date(e.generatedAt)}<br>下載請求：${date(e.requestedAt)}</p>`).join(''):'<p>尚無追蹤紀錄</p>'}</details>`;
 }).join('')}<script>document.getElementById('customerFilter').onchange=function(){document.querySelectorAll('.customer').forEach(e=>e.hidden=this.value==='new'?e.dataset.new!=='true':this.value==='due'?e.dataset.status!=='due':false)}</script></section>`;
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
