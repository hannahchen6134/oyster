import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purposeReport, careDefaults, reportPreview } from '../public/report-purpose.js';
import { buildA4Report } from '../public/a4-report.js';
import { reportChoiceFlex } from '../src/flex.js';
import worker, { handleTextMessage } from '../src/index.js';
import { reportFixture } from './support/report-fixture.mjs';
import { saveReportShot } from '../src/db.js';
const base = {pet:{petId:'p1',petName:'蚵仔'},from:'2026-09-01',to:'2026-09-07',days:7};
test('醫生摘要先異常、含用藥與精確體重、過期和未來資料不混入', () => {
  const d = purposeReport({...base,draft:{concern:'想確認食量'},highlights:[{eventDateTime:'2026-09-06 08:00',category:'vomit',note:'白沫'},{eventDateTime:'2026-10-01',category:'vomit',note:'未來資料'}],weights:[{date:'2026-09-06',amount:4.27}],rows:[{date:'2026-09-06',entryCount:2,kcal:40,medJson:JSON.stringify([{name:'藥A',status:'已吃',dose:'1顆'}])}]});
  assert.equal(d.sections[0].title,'這次最想讓醫生知道');
  assert.equal(d.sections[1].title,'近期異常與症狀');
  const html = reportPreview(d); assert.match(html,/4.27 kg/); assert.match(html,/藥A/); assert.doesNotMatch(html,/未來資料|可能腸胃/);
});
test('照護說明不把曾經吃40g變成每天指示；只含本貓的設定', () => {
  const defaults = careDefaults(base.pet,[{petId:'p1',medName:'本貓藥'},{petId:'p2',medName:'別貓藥'}],[]);
  assert.equal(defaults.feeding,''); assert.match(defaults.medicine,/本貓藥/); assert.doesNotMatch(defaults.medicine,/別貓/);
  const d = purposeReport({...base,purpose:'care',draft:defaults,rows:[{date:'2026-09-06',entryCount:1,dryFoodG:40}]});
  assert.equal(d.reportName,'照護說明'); assert.doesNotMatch(reportPreview(d),/40|每日紀錄|熱量/); assert.match(d.notice,/向主人確認/);
});
test('空醫生報告不塞空的體重或用藥區；補充文字安全跳脫', () => {
  const d = purposeReport({...base,draft:{concern:'<script>alert(1)</script>'}});
  assert.equal(d.empty,true); assert.equal(d.sections.length,1); const html=reportPreview(d);
  assert.match(html,/最近 7 天沒有足夠紀錄/); assert.doesNotMatch(html,/<script>|尚無體重|用藥紀錄/);
});
test('用途 Flex 是兩個直接開啟 LIFF 的選項，無中繼訊息 action', () => {
  const d = reportChoiceFlex('https://liff.line.me/example?go=doctor','https://liff.line.me/example?go=care');
  const s=JSON.stringify(d); assert.match(s,/這次要給誰/); assert.match(s,/給醫生看/); assert.match(s,/給照護者/); assert.doesNotMatch(s,/就醫使用|照護使用|"type":"message"/);
});
test('兩種輸出長文字分頁且全文保留，不裁切末尾', () => {
  const d=purposeReport({...base,purpose:'care',draft:{feeding:'餵食說明'.repeat(400)+'最後一句'}});
  for(const outputFormat of ['mobile','a4']) {
    const built=buildA4Report({...d,outputFormat}); assert.ok(built.pages>1); assert.match(built.html,/最後一句/); assert.equal((built.html.match(/餵食說明/g)||[]).length,400);
  }
});
test('報告既有 API 維持家庭隔離；主人與共照可讀、陌生人不可讀', async () => {
  const db=await reportFixture();
  for(const token of ['testowner','testhelper','teststranger','']) {
    for(const route of ['summary?petId=p1&from=2026-01-01&to=2026-12-31','highlights?petId=p1&days=14','weights?petId=p1','meds?petId=p1']) {
      const res=await worker.fetch(new Request('https://local.test/api/'+route,{headers:{Authorization:'Bearer '+token}}),{DB:db},{});
      assert.equal(res.status, token==='teststranger'?403:token?200:401,token+' '+route);
    }
  }
});
test('出報告 handler 在多貓家庭直接問對象；選貓在目的頁處理', async () => {
  const db=await reportFixture(), sent=[], menus=[]; const old=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{ if(String(url).includes('/message/'))sent.push(JSON.parse(options.body)); if(String(url).endsWith('/richmenu') && options.method==='POST') menus.push(JSON.parse(options.body));return new Response('{"richMenuId":"test-menu"}',{status:200}); };
  try {
    await handleTextMessage({source:{type:'user',userId:'owner'},replyToken:'test',message:{id:'report1',text:'出報告'}},{DB:db,LINE_CHANNEL_ACCESS_TOKEN:'test',LIFF_ID:'test-liff',ASSETS:{fetch:async()=>new Response('png')}},'https://local.test');
    assert.match(JSON.stringify(sent),/這次要給誰/); assert.match(JSON.stringify(sent),/go=doctor/); assert.match(JSON.stringify(sent),/go=care/);
    assert.equal(menus.length,1);
    assert.deepEqual(menus[0].areas.map((a)=>a.action.type),['message','message','message','uri','message','message']);
    assert.deepEqual(menus[0].areas.filter((a)=>a.action.type==='message').map((a)=>a.action.text),['記一筆','近七天記錄','出報告','怎麼記','照護月曆']);
    assert.equal(menus[0].areas[3].action.uri,'https://liff.line.me/test-liff');
  } finally { globalThis.fetch=old; }
});
test('分享圖只回指定PNG，未登入不可上傳，過期與猜錯URL拒絕', async () => {
  const db=await reportFixture(),env={DB:db};
  const noauth=await worker.fetch(new Request('https://local.test/shot',{method:'POST',body:JSON.stringify({png:'data:image/png;base64,dGVzdA=='})}),env,{});
  assert.equal(noauth.status,401);
  const id=await saveReportShot(db,'owner','dGVzdA==');
  assert.ok(id.length>=64);
  const res=await worker.fetch(new Request('https://local.test/shot/'+id),env,{});
  assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'image/png');assert.equal(await res.text(),'test');
  assert.equal((await worker.fetch(new Request('https://local.test/shot/wrong'),env,{})).status,404);
  db.prepare('UPDATE report_shots SET createdAt=? WHERE id=?').bind(new Date(Date.now()-7*3600000).toISOString(),id).run();
  assert.equal((await worker.fetch(new Request('https://local.test/shot/'+id),env,{})).status,410);
});
