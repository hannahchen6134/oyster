// Commit 2：RC2 中文數字（限數量上下文）＋ RC3 有上下文的事件切分 ＋ case10 用藥不被吞。
// 這些測試描述「期望的正確行為」，修改前應失敗、修改後通過（case10 尤其：不得把用藥固化成錯誤規格）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/parser.js';

const rec = (s) => { const r = parseMessage(s); assert.equal(r.type, 'record', `「${s}」應 record，實為 ${r.type}`); return r.record; };
const multi = (s) => { const r = parseMessage(s); assert.equal(r.type, 'multiRecord', `「${s}」應 multiRecord，實為 ${r.type}`); return r; };
const pick = (r, cat) => r.records.find((x) => x.category === cat);

// ---------- RC2：中文數字（僅在數量上下文轉換）----------
test('RC2：類別詞＋中文數字 罐頭三十三 → 食物 33g', () => {
  const x = rec('罐頭三十三');
  assert.equal(x.category, 'food'); assert.equal(x.foodType, '罐頭'); assert.equal(x.amount, 33);
});
test('RC2：品名＋類別＋中文數字＋單位 皇家罐頭三十三克 → 食物 罐頭/皇家/33', () => {
  const x = rec('皇家罐頭三十三克');
  assert.equal(x.category, 'food'); assert.equal(x.foodType, '罐頭'); assert.equal(x.itemName, '皇家'); assert.equal(x.amount, 33);
});
test('RC2：品名尾隨中文數字（無單位）罐頭皇家三十三 → 食物 罐頭/皇家/33', () => {
  const x = rec('罐頭皇家三十三');
  assert.equal(x.category, 'food'); assert.equal(x.foodType, '罐頭'); assert.equal(x.itemName, '皇家'); assert.equal(x.amount, 33);
});
test('RC2 界線：「第三次」中間的數字（後面接字、非結尾）不被結尾規則轉換', () => {
  const x = rec('備註 第三次回診');
  assert.equal(x.category, 'note');
  assert.ok(x.note.includes('第三次'), '「第三次」不是數量，不得被轉換');
});
test('RC2：水＋中文數字 水八 → 水 8ml；喝水八毫升 → 水 8ml', () => {
  assert.equal(rec('水八').category, 'water');
  assert.equal(rec('水八').amount, 8);
  assert.equal(rec('喝水八毫升').amount, 8);
});
test('RC2：罐頭三十三水八 → 食物 33 ＋ 水 8', () => {
  const r = multi('罐頭三十三水八');
  assert.equal(pick(r, 'food').amount, 33);
  assert.equal(pick(r, 'water').amount, 8);
});
test('RC2：皇家罐頭三十三克水八毫升 → 食物 罐頭/皇家/33 ＋ 水 8', () => {
  const r = multi('皇家罐頭三十三克水八毫升');
  const f = pick(r, 'food'); const w = pick(r, 'water');
  assert.ok(f && f.foodType === '罐頭' && f.itemName === '皇家' && f.amount === 33);
  assert.ok(w && w.amount === 8);
});
test('RC2 界線：中文數字不在數量上下文時不轉換（三花貓當備註不被改成 3花貓量）', () => {
  // 「備註 三花貓」：三 不是數量（後面不是單位、前面不是類別/水詞）→ 不得被當數字
  const x = rec('備註 三花貓很乖');
  assert.equal(x.category, 'note');
  assert.ok(x.note.includes('三花貓'), '中文數字在非數量上下文不得被替換');
});

// ---------- RC3：case10 用藥不被吞進水備註 ----------
test('case10：罐頭33水8早藥吃了 → 食物33 ＋ 水8 ＋ 早藥已吃（三筆，藥不落 water.note）', () => {
  const r = multi('罐頭33水8早藥吃了');
  const f = pick(r, 'food'); const w = pick(r, 'water'); const m = pick(r, 'med');
  assert.ok(f && f.amount === 33, '食物 33g');
  assert.ok(w && w.amount === 8, '水 8ml');
  assert.ok(m, '應有用藥事件');
  assert.equal(m.medSlot, '早');
  assert.equal(m.medStatus, '已吃');
  assert.ok(!(w.note || '').includes('藥'), '用藥不得落入 water.note');
  assert.equal(r.records.length, 3, '恰三筆');
});

test('RC3 用藥時段／狀態多型態（黏字）', () => {
  const cases = [
    ['早藥已吃', '早', '已吃'], ['晚藥吃了', '晚', '已吃'], ['晚藥已吃', '晚', '已吃'],
    ['早藥未吃', '早', '漏餵'], ['晚藥未吃', '晚', '漏餵'],
    ['早上的藥吃了', '早', '已吃'], ['晚上的藥已吃', '晚', '已吃']
  ];
  for (const [s, slot, status] of cases) {
    const x = rec(s);
    assert.equal(x.category, 'med', `${s} 應為用藥`);
    assert.equal(x.medSlot, slot, `${s} 時段`);
    assert.equal(x.medStatus, status, `${s} 狀態`);
  }
});

test('case15：皇家罐頭33克水8毫升早藥已吃 → 食物 皇家/33 ＋ 水8 ＋ 早藥已吃', () => {
  const r = multi('皇家罐頭33克水8毫升早藥已吃');
  const f = pick(r, 'food'); const w = pick(r, 'water'); const m = pick(r, 'med');
  assert.ok(f && f.foodType === '罐頭' && f.itemName === '皇家' && f.amount === 33);
  assert.ok(w && w.amount === 8);
  assert.ok(m && m.medSlot === '早' && m.medStatus === '已吃');
  assert.ok(!(w.note || '').includes('藥'));
});

// ---------- RC3 反例：品名含「水／藥」不得被誤切 ----------
test('RC3 反例：品名含水不得切出 water', () => {
  // 皇家水解蛋白33（無類別詞）→ 中性候選（交反查），品名保留「水解蛋白」，不切 water
  const c = parseMessage('皇家水解蛋白33');
  assert.equal(c.type, 'item_lookup_candidate');
  assert.equal(c.itemName, '皇家水解蛋白');
  assert.equal(c.amount, 33);
  // 水解蛋白罐頭33 → 食物 罐頭/水解蛋白/33，不得切出 water
  const x = rec('水解蛋白罐頭33');
  assert.equal(x.category, 'food'); assert.equal(x.foodType, '罐頭'); assert.equal(x.itemName, '水解蛋白'); assert.equal(x.amount, 33);
});
test('RC3 反例：罐頭泡水33 依既有語意不切出獨立 water 事件', () => {
  const r = parseMessage('罐頭泡水33');
  assert.notEqual(r.type, 'multiRecord', '不得因含「水」就拆成兩段');
  if (r.type === 'record') assert.notEqual(r.record.category, 'water');
});
test('RC3 反例：品名的水 vs 句尾水事件——皇家水解蛋白33水8 只切句尾水8', () => {
  const r = multi('皇家水解蛋白33水8');
  assert.ok(pick(r, 'water') && pick(r, 'water').amount === 8, '句尾水8應記');
  // 品名段（皇家水解蛋白33）成為 lookup 候選，不因品名的「水」被誤切、也不遺失
  assert.ok((r.candidates || []).some((c) => c.itemName.includes('水解蛋白') && c.amount === 33), '品名段保留為候選，不誤切/不遺失');
  assert.ok(!r.records.some((x) => x.category === 'water' && x.amount !== 8), '不得多出別的 water');
});

// ---------- 部署前必修③：罐頭泡水33 歧義（不預設 33＝加水）----------
test('罐頭泡水33 → foodWaterAmbiguous（不預設）；罐頭30泡水33（兩者都有）→ 正常記錄', () => {
  const a = parseMessage('罐頭泡水33');
  assert.equal(a.type, 'foodWaterAmbiguous');
  assert.equal(a.foodType, '罐頭');
  assert.equal(a.amount, 33);
  const b = parseMessage('罐頭30泡水33');
  assert.equal(b.type, 'record');
  assert.equal(b.record.category, 'food');
  assert.equal(b.record.amount, 30);
  assert.equal(b.record.addedWaterMl, 33);
});

// ---------- 藥字在品名中不得誤切 ----------
test('RC3 反例：品名含「藥」但無時段/狀態 → 不誤切成用藥', () => {
  // 「藥膳罐頭30」：藥膳是品名，不是用藥事件
  const x = rec('藥膳罐頭30');
  assert.equal(x.category, 'food');
  assert.equal(x.foodType, '罐頭');
  assert.ok(x.itemName.includes('藥膳'));
});
