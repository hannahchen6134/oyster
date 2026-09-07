import { ALL_RECORDS, FREQUENT_RECORDS } from './frequent-records.js';
import { LINE_EVENT, afterEventReply } from './line-event.js';
import { taipeiToday, addDays } from './util.js';

export const shortcutProfileKey = actor => `recordShortcuts:${actor}`;
const catalog = new Map(ALL_RECORDS.map(([label,kind])=>[kind,label]));
export function readShortcutProfile(raw,owner,now=Date.now()) {
  try {
    const p=typeof raw==='string'?JSON.parse(raw):raw;
    if(p?.version!==1||p.owner!==owner||!Number.isFinite(p.at)||p.at>now||now-p.at>30*86400000||!Array.isArray(p.entries))return null;
    if(p.entries.length<6||p.entries.length>8||p.entries.some(e=>!Array.isArray(e)||e.length!==2||!(catalog.get(e[1])===e[0]||(e[1]==='dry'&&e[0]==='乾糧')||(e[1]==='more'&&e[0]==='更多紀錄'))))return null;
    return p;
  } catch { return null; }
}
function kindOf(log) {
  if(log.category!=='food')return catalog.has(log.category)?log.category:null;
  return log.foodType==='乾糧'?'dry':log.foodType==='零食'?'snack':['主食罐','罐頭'].includes(log.foodType)?'wet':null;
}
export function rankRecordShortcuts(logs,previous=[],dryLabel='乾乾') {
  const counts=new Map();
  for(const log of logs){const kind=kindOf(log);if(kind)counts.set(kind,(counts.get(kind)||0)+1);}
  // Sparse history should not make the initial menu change after a single tap.
  if([...counts.values()].reduce((a,b)=>a+b,0)<10)return FREQUENT_RECORDS;
  const order=ALL_RECORDS.map(([,kind])=>kind);
  const prior=previous.map(([,kind])=>kind);
  const tie=kind=>prior.includes(kind)?prior.indexOf(kind):prior.length+order.indexOf(kind);
  const frequent=order.filter(kind=>(counts.get(kind)||0)>=2).sort((a,b)=>(counts.get(b)-counts.get(a))||tie(a)-tie(b));
  const chosen=frequent.slice(0,7);
  // Keep at least five category targets. Less-used choices are always in More.
  for(const kind of order){if(chosen.length>=5)break;if(!chosen.includes(kind))chosen.push(kind);}
  return [...chosen.map(kind=>[kind==='dry'&&dryLabel==='乾糧'?'乾糧':catalog.get(kind),kind]),['更多紀錄','more']];
}

export function useShortcutProfile(env,user,owner) {
  const profile=readShortcutProfile(user?.shortcutProfile,owner);
  if(env[LINE_EVENT])env[LINE_EVENT].shortcutEntries=profile?.entries||null;
  return profile;
}

export async function prepareShortcutProfile(env,user,owner,pets,event) {
  const profile=useShortcutProfile(env,user,owner),scope=env[LINE_EVENT],actor=event.source?.userId;
  // Stable for one Taipei calendar day; load the prior ordering without another
  // DB round trip. Cache construction is owned by the webhook's after-reply work.
  if(!scope||!actor||profile?.day===taipeiToday()||!pets.length)return;
  const authorized=pets.filter(p=>p.ownerLineUserId===owner&&!p.isDeleted);
  if(!authorized.length)return;
  await afterEventReply(env,'shortcuts:'+actor,async()=>{
    const at=Date.now(),day=taipeiToday(),from=addDays(day,-29),to=addDays(day,1);
    // Uses existing idx_logs_pet_event. Read a bounded recent sample per cat,
    // filtering by the actual recorder, not the family's data-owner ID.
    const logs=[];
    for(const pet of authorized){
      const {results}=await env.DB.prepare(`SELECT category,foodType,sourceMessageId,eventDateTime,createdAt FROM logs
        WHERE petId=? AND lineUserId=? AND eventDateTime>=? AND eventDateTime<? AND isDeleted=0
          AND COALESCE(NULLIF(recordedBy,''),lineUserId)=? AND NOT(category='water' AND note='罐頭加水')
        ORDER BY eventDateTime DESC LIMIT 200`).bind(pet.petId,owner,from,to,actor).all();
      logs.push(...(results||[]));
    }
    const recent=logs.sort((a,b)=>b.eventDateTime.localeCompare(a.eventDateTime)||b.createdAt.localeCompare(a.createdAt)).slice(0,200);
    const savedDry=recent.some(l=>l.sourceMessageId===event.message?.id&&kindOf(l)==='dry');
    const dryLabel=savedDry&&String(event.message?.text||'').includes('乾糧')?'乾糧':profile?.entries.find(([,kind])=>kind==='dry')?.[0]||'乾乾';
    const value={version:1,owner,at,day,entries:rankRecordShortcuts(recent,profile?.entries,dryLabel)};
    // An older refresh cannot overwrite a newer cache. No raw text or amounts
    // are copied; failures affect only menu preferences, never saved care data.
    await env.DB.prepare(`INSERT INTO app_kv(k,v,updatedAt) VALUES(?,?,?)
      ON CONFLICT(k) DO UPDATE SET v=excluded.v,updatedAt=excluded.updatedAt
      WHERE app_kv.updatedAt<excluded.updatedAt`).bind(shortcutProfileKey(actor),JSON.stringify(value),new Date(at).toISOString()).run();
  });
}
