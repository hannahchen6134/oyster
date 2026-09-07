import { appKvGet, appKvSet, listPets, getPet, getSummaries, listVetsByOwner, getUser } from './db.js';
import { isBetaAllowed } from './plan.js';
import { careDefaults, purposeReport } from '../public/report-purpose.js';
import { handleReportApi, cleanDraft, classifyLines } from './report-sharing.js';
import { renderReportImages } from './report-renderer.js';
import { replyMessages, pushMessages, replyOrPush, replyOrPushFlex, showLoadingAnimation } from './line.js';
import { taipeiToday, addDays } from './util.js';

const flowKey=id=>`lineReportFlow:${id}`;
const encode=encodeURIComponent;
const read=async(db,key)=>{const raw=await appKvGet(db,key);return raw?JSON.parse(raw):null;};
function card(title,buttons,hint='') {
  return {type:'flex',altText:title.slice(0,400),contents:{type:'bubble',body:{type:'box',layout:'vertical',paddingAll:'20px',spacing:'md',backgroundColor:'#FFFDF8',contents:[
    {type:'text',text:title,wrap:true,weight:'bold',size:'lg',color:'#5A3617'},
    ...(hint?[{type:'text',text:hint,wrap:true,size:'sm',color:'#776A59'}]:[]),
    ...buttons.map(([label,data])=>({type:'button',style:'primary',color:'#734921',action:{type:'postback',label:label.slice(0,20),data,displayText:label.slice(0,300)}}))
  ]}}};
}
const button=(flow,action,extra='')=>`action=${action}&flow=${flow.id}${extra}`;
async function dbUpdateFlowId(db,actor,oldId,flow){
  await db.prepare("UPDATE app_kv SET v=?,updatedAt=? WHERE k=? AND json_extract(v,'$.id')=?").bind(JSON.stringify(flow),new Date().toISOString(),flowKey(actor),oldId).run();
}
async function saveFlow(db,actor,flow,create=false){
  if(create)return appKvSet(db,flowKey(actor),JSON.stringify(flow));
  await db.prepare("UPDATE app_kv SET v=?,updatedAt=? WHERE k=? AND json_extract(v,'$.id')=?").bind(JSON.stringify(flow),new Date().toISOString(),flowKey(actor),flow.id).run();
}
async function allowed(env,event,owner) {
  if(!isBetaAllowed(await getUser(env.DB,event.source?.userId))){await replyOrPush(env,event,'請先完成測試資格驗證，再使用出報告。');return false;}
  if(event.source?.type!=='user'){await replyOrPush(env,event,'請在與喵喵管家的一對一對話中出報告。');return false;}
  if(event.source.userId!==owner){await replyOrPush(env,event,'請由貓咪爸媽產生可分享的報告。');return false;}
  return true;
}
export async function startLineReport(env,event,owner) {
  if(!await allowed(env,event,owner))return;
  const pets=await listPets(env.DB,owner);
  if(!pets.length){await replyOrPush(env,event,'先新增貓咪，就可以整理報告。請輸入「新增貓咪」。');return;}
  const flow={id:crypto.randomUUID(),owner,stage:'pet',expiresAt:Date.now()+30*60000};
  await saveFlow(env.DB,event.source.userId,flow,true);
  await choosePets(env,event,flow,pets,0);
}
async function choosePets(env,event,flow,pets,offset) {
  const buttons=pets.slice(offset,offset+8).map(p=>[p.petName,button(flow,'reportPet',`&petId=${encode(p.petId)}`)]);
  if(offset+8<pets.length)buttons.push(['下一頁貓咪',button(flow,'reportPets',`&offset=${offset+8}`)]);
  if(offset>0)buttons.push(['上一頁貓咪',button(flow,'reportPets',`&offset=${Math.max(0,offset-8)}`)]);
  await replyOrPushFlex(env,event,card('要整理哪隻貓？',buttons,'先選貓咪，再選用途。報告圖片與 QR Code 都會傳在這裡。'),'請重新點「出報告」選擇貓咪。');
}
export async function buildLineReport(db,owner,petId,purpose) {
  const pet=await getPet(db,petId);
  if(!pet||pet.isDeleted||pet.ownerLineUserId!==owner)throw Error('forbidden pet');
  const to=taipeiToday(),from=addDays(to,-13);
  const [rows,logs,meds,vets,template]=await Promise.all([
    getSummaries(db,petId,from,to),
    db.prepare('SELECT * FROM logs WHERE petId=? AND isDeleted=0 AND substr(eventDateTime,1,10)>=? AND substr(eventDateTime,1,10)<=? ORDER BY eventDateTime DESC').bind(petId,from,to).all(),
    db.prepare('SELECT * FROM meds WHERE petId=? AND isDeleted=0').bind(petId).all(),
    listVetsByOwner(db,owner),read(db,`careTemplate:${owner}:${petId}`)
  ]);
  const draft=cleanDraft({...careDefaults(pet,meds.results,vets),...(template?.draft||{})});
  const highlights=logs.results.filter(r=>['vomit','vaccine','deworm','note','mood'].includes(r.category)||(['stool','urine'].includes(r.category)&&r.note));
  const weights=logs.results.filter(r=>r.category==='weight').map(r=>({...r,date:r.eventDateTime.slice(0,10)}));
  return {pet,draft,templateUpdatedAt:template?.updatedAt||null,snapshot:purposeReport({pet,purpose,rows,highlights,weights,recentLogs:logs.results,draft,from,to,days:14})};
}
function missingCare(draft){
  return [!draft.feeding?.trim()&&'餵食與補水方式',(!draft.medicine?.trim()||draft.medicine.includes('餵法待補'))&&'餵藥方法（不需用藥也請寫明）',!/(摸|抱|碰|喜歡|討厭|害怕|躲|個性|玩|安撫)/.test(draft.notes||'')&&'摸摸喜好與相處禁忌'].filter(Boolean);
}
async function askFeeding(env,event,flow,pet,draft={}) {
  flow.stage='feeding';await saveFlow(env.DB,event.source.userId,flow);
  const prompt=card(`補充${pet.petName}的照護說明`,[
    ['填好後出圖',button(flow,'reportRecheck')],['取消',button(flow,'reportCancel')]
  ],`還缺：${missingCare(draft).join('、')||'可直接貼上要更新的說明'}。\n直接回覆即可，已有資料不用重填。也可到後台補好範本，再回來點「填好後出圖」。`);
  if(env.LIFF_ID)prompt.contents.body.contents.splice(-2,0,{type:'button',style:'secondary',action:{type:'uri',label:'到後台補照護資料',uri:`https://liff.line.me/${env.LIFF_ID}?go=care`}});
  await replyOrPushFlex(env,event,prompt,'直接回覆缺少的照護說明，或輸入「取消」。');
}
export async function handleLineReportText(env,event,owner,text) {
  const flow=await read(env.DB,flowKey(event.source?.userId));
  if(!flow||flow.owner!==owner||flow.stage!=='feeding'||flow.expiresAt<Date.now())return false;
  if(['出報告','取消','算了'].includes(text)){
    flow.stage='cancelled';await saveFlow(env.DB,event.source.userId,flow);
    if(text==='出報告')return false;
    await replyOrPush(env,event,'已取消這次補充。');return true;
  }
  // Menu commands stay commands; do not accidentally save a navigation command as care instructions.
  if(['記一筆','近七天記錄','管家後台','照護站','怎麼記','照護月曆','今天'].includes(text)){flow.stage='cancelled';await saveFlow(env.DB,event.source.userId,flow);return false;}
  if(!await allowed(env,event,owner))return true;
  const pet=await getPet(env.DB,flow.petId);
  if(!pet||pet.isDeleted||pet.ownerLineUserId!==owner){await replyOrPush(env,event,'貓咪資料已變更，請重新點「出報告」。');return true;}
  if(!text.trim()||text.length>2000){await replyOrPush(env,event,'請用 2000 字以內補充照護說明。');return true;}
  flow.feeding=text.trim();flow.careDraft=classifyLines(text.trim());flow.stage='confirm';await saveFlow(env.DB,event.source.userId,flow);
  await replyOrPushFlex(env,event,card(`確認${pet.petName}的安排`,[
    ['確認並出圖',button(flow,'reportConfirm')],['重新填寫',button(flow,'reportEdit')],['取消',button(flow,'reportCancel')]
  ],flow.feeding+'\n\n確認後會存入這隻貓的照護範本，下次不用重填。'),'請點確認按鈕完成補充。');
  return true;
}
export async function handleLineReportPostback(env,event,owner,data,render=renderReportImages) {
  if(!await allowed(env,event,owner))return;
  const actor=event.source.userId,flow=await read(env.DB,flowKey(actor)),action=data.get('action');
  if(!flow||flow.owner!==owner||flow.id!==data.get('flow')||flow.expiresAt<Date.now()){
    await replyOrPush(env,event,'這張選擇卡已過期，請重新點「出報告」。');return;
  }
  if(action==='reportCancel'){flow.stage='cancelled';await saveFlow(env.DB,actor,flow);await replyOrPush(env,event,'已取消這次報告。');return;}
  if(action==='reportPets'&&flow.stage==='pet'){
    const pets=await listPets(env.DB,owner),offset=Math.max(0,Number(data.get('offset'))||0);
    return choosePets(env,event,flow,pets,Math.min(offset,Math.max(0,pets.length-1)));
  }
  if(action==='reportPet'&&flow.stage==='pet') {
    const pet=await getPet(env.DB,data.get('petId')||'');
    if(!pet||pet.isDeleted||pet.ownerLineUserId!==owner){await replyOrPush(env,event,'無法存取這隻貓。請重新點「出報告」。');return;}
    flow.petId=pet.petId;flow.stage='purpose';await saveFlow(env.DB,actor,flow);
    return replyOrPushFlex(env,event,card(`${pet.petName}的報告要給誰？`,[
      ['給醫生看',button(flow,'reportPurpose','&purpose=doctor')],['給照護者',button(flow,'reportPurpose','&purpose=care')]
    ],'給醫生：近 14 天紀錄。給照護者：已存照護安排與近期狀況。\n選好就傳圖片＋QR Code；分享連結有效 7 天，持有連結的人可以閱讀。'),'請重新點「出報告」選擇用途。');
  }
  if(action==='reportPurpose'&&flow.stage==='purpose') {
    if(!['doctor','care'].includes(data.get('purpose')))return;
    flow.purpose=data.get('purpose');flow.stage='ready';await saveFlow(env.DB,actor,flow);
    const bundle=await buildLineReport(env.DB,owner,flow.petId,flow.purpose);
    if(flow.purpose==='care'&&missingCare(bundle.draft).length)return askFeeding(env,event,flow,bundle.pet,bundle.draft);
  } else if(action==='reportEdit'&&flow.purpose==='care'&&['confirm','done','ready'].includes(flow.stage)) {
    if(flow.stage==='done'){const oldId=flow.id;flow.id=crypto.randomUUID();flow.sent=0;await dbUpdateFlowId(env.DB,actor,oldId,flow);}
    const bundle=await buildLineReport(env.DB,owner,flow.petId,'care');return askFeeding(env,event,flow,bundle.pet,bundle.draft);
  } else if(action==='reportRecheck'&&flow.stage==='feeding') {
    const bundle=await buildLineReport(env.DB,owner,flow.petId,'care');
    if(missingCare(bundle.draft).length)return askFeeding(env,event,flow,bundle.pet,bundle.draft);
    flow.stage='ready';await saveFlow(env.DB,actor,flow);
  } else if(action==='reportConfirm'&&flow.stage==='confirm') {
    const bundle=await buildLineReport(env.DB,owner,flow.petId,'care');
    const additions=flow.careDraft||{feeding:flow.feeding};
    const merged=Object.fromEntries(Object.entries(additions).filter(([,v])=>v?.trim()).map(([k,v])=>[k,[...new Set([bundle.draft[k]?.replace(/(?: · )?餵法待補/g,''),v].filter(Boolean))].join('\n')]));
    const draft=cleanDraft({...bundle.draft,...merged,rawNotes:flow.feeding,rawApplied:true});
    await appKvSet(env.DB,`careTemplate:${owner}:${flow.petId}`,JSON.stringify({draft,updatedAt:new Date().toISOString()}));
    if(missingCare(draft).length)return askFeeding(env,event,flow,bundle.pet,draft);
    // Edited content is a new immutable report, never reuse the earlier image cache.
    const oldId=flow.id;flow.id=crypto.randomUUID();flow.sent=0;
    await dbUpdateFlowId(env.DB,actor,oldId,flow);
    flow.stage='ready';await saveFlow(env.DB,actor,flow);
  } else if(action==='reportGenerate'&&flow.stage==='feeding') {
    const bundle=await buildLineReport(env.DB,owner,flow.petId,'care');return askFeeding(env,event,flow,bundle.pet,bundle.draft);
  } else if(action==='reportGenerate'&&flow.stage==='ready') {
    flow.stage='ready';await saveFlow(env.DB,actor,flow);
  } else { await replyOrPush(env,event,'這一步已處理，請使用最新的按鈕，或重新點「出報告」。');return; }
  return deliverReport(env,event,flow,render);
}

async function deliverReport(env,event,flow,render) {
  const actor=event.source.userId,db=env.DB;
  // Atomic lease across isolates prevents double taps from running two browsers or sending two reports.
  const lock=`lineReportLock:${flow.id}`,now=Date.now();
  const acquired=await db.prepare(`INSERT INTO app_kv(k,v,updatedAt) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updatedAt=excluded.updatedAt WHERE CAST(app_kv.v AS INTEGER)<? RETURNING k`).bind(lock,String(now+90000),new Date().toISOString(),now).first();
  if(!acquired){await replyOrPush(env,event,'報告正在整理中，請稍等一下。');return;}
  try {
    const latest=await read(db,flowKey(actor));
    if(!latest||latest.id!==flow.id||['done','cancelled'].includes(latest.stage))return;
    if(await appKvGet(db,`lineReportDelivered:${flow.id}`))return;
    flow.sent=latest.sent||0;
    await showLoadingAnimation(env,actor);
    const bundle=await buildLineReport(db,flow.owner,flow.petId,flow.purpose);
    const base=String(env.APP_BASE_URL||'').replace(/\/$/,'')||new URL(event.__reportBaseUrl).origin;
    const request=new Request(base+'/api/report-shares',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':flow.id},body:JSON.stringify({petId:flow.petId,confirmed:true,snapshot:bundle.snapshot,days:7})});
    const response=await handleReportApi(request,env,new URL(request.url),actor,flow.owner),share=await response.json();
    if(!share.ok)throw Error('share unavailable');
    const stored=await read(db,'reportShare:'+share.id);
    let manifest=await read(db,'lineReportImages:'+share.id);
    if(!manifest){
      const pngs=await render(env,stored.snapshot,base+share.url);
      if(!pngs.length||pngs.length<2)throw Error('images incomplete');
      for(let i=0;i<pngs.length;i++)await appKvSet(db,`lineReportImage:${share.id}:${i}`,JSON.stringify({png:pngs[i],expiresAt:share.expiresAt}));
      manifest={count:pngs.length,expiresAt:share.expiresAt};await appKvSet(db,'lineReportImages:'+share.id,JSON.stringify(manifest));
    }
    const messages=Array.from({length:manifest.count},(_,i)=>({type:'image',originalContentUrl:`${base}${share.url}/image/${i}`,previewImageUrl:`${base}${share.url}/image/${i}`}));
    messages.push({type:'text',text:`${bundle.pet.petName}的${stored.snapshot.reportName}\n共 ${manifest.count-1} 張報告＋1 張 QR Code，可直接儲存或轉傳。\n查看報告（7 天內有效）：${base}${share.url}`,...(flow.purpose==='care'?{quickReply:{items:[{type:'action',action:{type:'postback',label:'補充照護說明',data:button(flow,'reportEdit'),displayText:'補充照護說明'}}]}}:{})});
    let sent=Number(flow.sent||0);
    for(let i=sent;i<messages.length;i+=5){
      const batch=messages.slice(i,i+5);
      if(i===0&&event.replyToken){try{await replyMessages(env,event.replyToken,batch);}catch{await pushMessages(env,actor,batch);}}
      else await pushMessages(env,actor,batch);
      sent=i+batch.length;flow.sent=sent;await saveFlow(db,actor,flow);
    }
    await appKvSet(db,`lineReportDelivered:${flow.id}`,new Date().toISOString());
    flow.stage='done';await saveFlow(db,actor,flow);
  } catch(error) {
    console.warn('line report generation failed:',error.message);
    flow.stage='ready';await saveFlow(db,actor,flow);
    await replyOrPushFlex(env,event,card('報告暫時沒有完成',[[flow.sent?'補傳剩餘圖片':'重新產生',button(flow,'reportGenerate')]],'資料仍保留。請稍後再試，完成後會直接傳回這裡。'),'報告暫時沒有完成，請稍後重新點「出報告」。');
  } finally {await db.prepare('DELETE FROM app_kv WHERE k=?').bind(lock).run();}
}
