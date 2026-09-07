import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { taipeiToday, nowIso } from '../../src/util.js';
import { insertLog, recomputeDay } from '../../src/db.js';
export class D1 {
  constructor() {
    this.sdb = new DatabaseSync(':memory:');
    for (const p of ['schema.sql','migrations/0012_app_kv.sql','migrations/0010_beta_access.sql']) this.sdb.exec(readFileSync(new URL('../../'+p, import.meta.url),'utf8'));
  }
  prepare(sql) {
    const db = this.sdb; let args = [];
    return {
      bind(...values) { args = values.map((v) => v == null ? null : typeof v === 'boolean' ? Number(v) : v); return this; },
      first() { return db.prepare(sql).get(...args) || null; },
      all() { return { results: db.prepare(sql).all(...args) }; },
      run() { const r = db.prepare(sql).run(...args); return { meta: { changes:r.changes, last_row_id:Number(r.lastInsertRowid) } }; }
    };
  }
  async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); }
}
export async function reportFixture() {
  const db = new D1(), today = taipeiToday(), now = nowIso();
  for (const u of ['owner','single','helper','stranger','empty']) {
    db.prepare('INSERT INTO users (lineUserId, displayName, betaAccess, createdAt, updatedAt) VALUES (?,?,1,?,?)').bind(u,u,now,now).run();
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').bind('test'+u,u,new Date(Date.now()+30*86400000).toISOString(),now).run();
  }
  for (const [id,owner,name] of [['p1','owner','蚵仔'],['p2','owner','麵線'],['s1','single','小花'],['x1','stranger','別家的貓'],['e1','empty','新朋友']]) {
    db.prepare('INSERT INTO pets (petId,ownerLineUserId,petName,conditionNote,defaultVetId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)').bind(id,owner,name,'怕吹風機，請關好窗戶','vet'+owner,now,now).run();
    if (owner === 'empty') continue;
    db.prepare('INSERT INTO meds (medId,petId,medName,doseAmount,doseUnit,schedule,instruction,createdAt,updatedAt) VALUES (?,?,?,1,?,?,?,?,?)').bind('m'+id,id,'測試藥'+id,'顆','每天晚上','依原處方',now,now).run();
    for (const [category,more] of [['food',{amount:40,foodType:'主食罐',itemName:'測試罐頭'+id,kcal:40,foodWaterMl:30}],['water',{amount:20,unit:'ml'}],['vomit',{note:'白色泡沫'+id}],['med',{itemName:'測試藥'+id,medStatus:'已吃',medSlot:'晚',doseText:'1顆'}],['weight',{amount:4.27,unit:'kg'}]]) {
      await insertLog(db,{lineUserId:owner,petId:id,eventDateTime:today+' 08:00',category,...more,sourceMessageId:'fixture'+id+category});
    }
    await recomputeDay(db,id,today);
  }
  db.prepare("INSERT INTO care_members (memberId,petId,ownerLineUserId,memberLineUserId,status,createdAt,updatedAt) VALUES ('c1','p1','owner','helper','accepted',?,?)").bind(now,now).run();
  for (const u of ['owner','single']) db.prepare('INSERT INTO vets (vetId,ownerLineUserId,hospitalName,phone,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').bind('vet'+u,u,'測試動物醫院','02-00000000',now,now).run();
  return db;
}
