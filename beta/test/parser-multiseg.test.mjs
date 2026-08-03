// 多段輸入安全性：加水取值、multiRecord 不靜默丟棄、逗號/頓號/換行、保守連接詞。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/parser.js';

function rec(s) { const r = parseMessage(s); assert.equal(r.type, 'record', `「${s}」應為 record，實為 ${r.type}`); return r.record; }

test('加水修正：罐頭34克加水14克 → food 34g + addedWater 14ml（不再誤記 14g）', () => {
  const x = rec('罐頭34克加水14克');
  assert.equal(x.category, 'food');
  assert.equal(x.amount, 34);
  assert.equal(x.addedWaterMl, 14);
});

test('加水回歸：既有正常句型不被改壞', () => {
  for (const [s, amt, aw] of [['罐頭30加水10', 30, 10], ['罐頭30g加水10ml', 30, 10], ['罐頭30克 加水10克', 30, 10], ['罐頭30', 30, 0]]) {
    const x = rec(s);
    assert.equal(x.category, 'food');
    assert.equal(x.amount, amt, `${s} amount`);
    assert.equal(x.addedWaterMl, aw, `${s} addedWater`);
  }
  assert.equal(rec('水10').category, 'water');
});

test('RC1：罐頭皇家/皇家罐頭 黏字倒序現在能解析成食物（品項候選＝皇家）＋水正常記、數量不交換', () => {
  for (const s of ['罐頭皇家34g 水14g', '皇家罐頭34g水14g', '罐頭皇家34g，水14g', '罐頭皇家34g\n水14g']) {
    const r = parseMessage(s);
    assert.equal(r.type, 'multiRecord', `${s} 應 multiRecord`);
    const food = r.records.find((x) => x.category === 'food');
    const water = r.records.find((x) => x.category === 'water');
    assert.ok(food && food.foodType === '罐頭' && food.amount === 34 && food.itemName === '皇家', `${s} 食物應為 罐頭/皇家/34`);
    assert.ok(water && water.amount === 14, `${s} 應記到 water 14`);
    assert.equal((r.unparsed || []).length, 0, `${s} 品項已可解析，不應有未解析片段`);
    // 不得把 34 當成 water 的量（不交換數量）
    assert.notEqual(water.amount, 34, `${s} 不得把 34 記成喝水`);
  }
});

test('multiRecord 不靜默丟棄：真的看不懂的片段仍保留在 unparsed、水正常記', () => {
  // 「abc」沒有類別詞也沒有數量 → 無法解析，必須明列尚未記錄，不得靜默丟棄
  const r = parseMessage('abc 水14');
  assert.equal(r.type, 'multiRecord');
  const water = r.records.find((x) => x.category === 'water');
  assert.ok(water && water.amount === 14, '水 14 應正常記');
  assert.ok(Array.isArray(r.unparsed) && r.unparsed.some((u) => u.includes('abc')), '看不懂的 abc 應保留在 unparsed');
});

test('保守連接詞：然後/接著 後接事件詞才分隔；再＋喝水＝兩筆', () => {
  const r1 = parseMessage('皇家罐頭34克然後水14克');
  assert.equal(r1.type, 'multiRecord');
  assert.ok(r1.records.some((x) => x.category === 'food' && x.amount === 34 && x.itemName === '皇家')); // RC1：皇家罐頭34 現在可解析
  assert.ok(r1.records.some((x) => x.category === 'water' && x.amount === 14));
  assert.equal((r1.unparsed || []).length, 0);

  const r2 = parseMessage('罐頭34克再喝水14克');
  assert.equal(r2.type, 'multiRecord');
  assert.ok(r2.records.some((x) => x.category === 'food' && x.amount === 34));
  assert.ok(r2.records.some((x) => x.category === 'water' && x.amount === 14));
  assert.equal(r2.unparsed.length, 0);
});

test('連接詞不得亂拆：後面不是事件時不分隔', () => {
  assert.equal(rec('水20再說').amount, 20);          // 「再說」不是事件 → 不拆，正常記水 20
  assert.equal(parseMessage('益生菌然後散步').type, 'unknown'); // 「散步」不是事件 → 不拆
});

test('水/加水語意：只有「加水」屬 addedWater，裸「水／喝水」是獨立喝水事件', () => {
  // 加水 → 併入該筆食物的 addedWater
  const a = rec('罐頭34克加水14克');
  assert.equal(a.category, 'food'); assert.equal(a.amount, 34); assert.equal(a.addedWaterMl, 14);
  // 裸「水」→ 獨立喝水事件（食物不含 addedWater）
  const b = parseMessage('罐頭34克 水14克');
  assert.equal(b.type, 'multiRecord');
  const bf = b.records.find((x) => x.category === 'food');
  const bw = b.records.find((x) => x.category === 'water');
  assert.ok(bf && bf.amount === 34 && (bf.addedWaterMl || 0) === 0, '食物 34g、不含加水');
  assert.ok(bw && bw.amount === 14, '獨立喝水 14');
  // 「喝水」→ 同樣獨立
  const c = parseMessage('罐頭34克 喝水14克');
  assert.equal(c.type, 'multiRecord');
  assert.ok(c.records.some((x) => x.category === 'water' && x.amount === 14));
  assert.ok(c.records.some((x) => x.category === 'food' && x.amount === 34 && (x.addedWaterMl || 0) === 0));
});
