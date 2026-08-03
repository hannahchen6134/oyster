import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLeading, parseMessage } from '../src/parser.js';

// 家庭：蚵仔、咪咪、咪（測名稱重疊「咪」不可吃掉「咪咪」）
const FAMILY = ['蚵仔', '咪咪', '咪'];

function ev(rest) {
  const r = parseMessage(rest);
  return r.type === 'record' ? `${r.record.category} ${r.record.amount}${r.record.unit}` : r.type;
}

test('第一階段①：既有「貓名＋空格」仍判為 named 蚵仔（不改壞）', () => {
  const r = analyzeLeading('蚵仔 喝水 1ml', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '蚵仔');
  assert.equal(ev(r.rest), 'water 1ml');
});

test('第一階段②：黏著貓名 蚵仔喝水1ml → named 蚵仔', () => {
  const r = analyzeLeading('蚵仔喝水1ml', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '蚵仔');
  assert.equal(ev(r.rest), 'water 1ml');
});

test('第一階段②：全形逗號 蚵仔，喝水1ml → named 蚵仔', () => {
  const r = analyzeLeading('蚵仔，喝水1ml', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '蚵仔');
  assert.equal(ev(r.rest), 'water 1ml');
});

test('第一階段②：全形冒號 蚵仔：喝水1ml → named 蚵仔', () => {
  const r = analyzeLeading('蚵仔：喝水1ml', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '蚵仔');
  assert.equal(ev(r.rest), 'water 1ml');
});

test('第一階段⑦：名稱重疊——咪咪喝水1ml 必須匹配「咪咪」而非「咪」', () => {
  const r = analyzeLeading('咪咪喝水1ml', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '咪咪');
});

test('第一階段③：不存在的貓名（旺財）+ 空格 → leadingUnknown，不得判成 named', () => {
  const r = analyzeLeading('旺財 喝水 1ml', FAMILY);
  assert.equal(r.kind, 'leadingUnknown');
  assert.equal(r.prefix, '旺財');
  assert.equal(ev(r.eventText), 'water 1ml');
});

test('第一階段③：不存在的貓名（旺財）+ 黏著 → leadingUnknown', () => {
  const r = analyzeLeading('旺財喝水1ml', FAMILY);
  assert.equal(r.kind, 'leadingUnknown');
  assert.equal(r.prefix, '旺財');
});

test('第一階段④：xyz 喝水1ml → leadingUnknown，不得靜默', () => {
  const r = analyzeLeading('xyz喝水1ml', FAMILY);
  assert.equal(r.kind, 'leadingUnknown');
  assert.equal(r.prefix, 'xyz');
});

test('第一階段④：剛剛喝水1ml → leadingUnknown，不得判成貓叫「剛剛」', () => {
  const r = analyzeLeading('剛剛喝水1ml', FAMILY);
  assert.equal(r.kind, 'leadingUnknown');
  assert.equal(r.prefix, '剛剛');
});

test('第一階段⑤：既有正常格式一律 clean（行為不變）', () => {
  for (const s of ['喝水1ml', '水20', '罐頭30', '昨天 21:30 水20', '吃了 罐頭 30', '吃了罐頭30', '水20 乾糧5 藥早已吃']) {
    assert.equal(analyzeLeading(s, FAMILY).kind, 'clean', `「${s}」應為 clean`);
  }
});

test('第一階段⑤：只打貓名（蚵仔）→ clean（交回既有切換流程）', () => {
  assert.equal(analyzeLeading('蚵仔', FAMILY).kind, 'clean');
});

test('回歸：沒有家庭貓名清單時，一般格式仍 clean、不誤判', () => {
  assert.equal(analyzeLeading('水 20', []).kind, 'clean');
  assert.equal(analyzeLeading('喝水1ml', []).kind, 'clean');
});

// 食物名內含類別詞（希爾斯「罐頭」）不得被誤切成通用罐頭。已知貓名先剝離：
//  - 剝出貓名、後段像食物名＋份量卻無法可靠解析 → partial（辨認到貓、但不寫入，交第二階段）
//  - 沒有貓名 → clean（走一般 unknown）
test('A. 蚵仔喝水1ml → named 蚵仔／water／1ml', () => {
  const r = analyzeLeading('蚵仔喝水1ml', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '蚵仔');
  assert.equal(ev(r.rest), 'water 1ml');
});

// RC1 後：後段食物（品項名黏著類別詞）現在能解析，貓名仍先剝離＝named；
// 「品項是否可靠對到」交下游 handleRecord（對不到→品項確認卡，確認前不寫入）。
test('B. 蚵仔希爾斯罐頭23g → named 蚵仔，後段解析成食物（品項候選＝希爾斯，交下游比對）', () => {
  const r = analyzeLeading('蚵仔希爾斯罐頭23g', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '蚵仔');
  assert.equal(r.rest, '希爾斯罐頭 23g');
  const sub = parseMessage(r.rest);
  assert.equal(sub.type, 'record');
  assert.equal(sub.record.category, 'food');
  assert.equal(sub.record.foodType, '罐頭');
  assert.equal(sub.record.itemName, '希爾斯');
  assert.equal(sub.record.amount, 23);
});

test('B. 標點版 蚵仔，希爾斯罐頭23g → named 蚵仔', () => {
  const r = analyzeLeading('蚵仔，希爾斯罐頭23g', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '蚵仔');
});

test('C. 希爾斯罐頭23g → clean（無貓名）；RC1 後 parseMessage 認得食物，品項候選＝希爾斯（交下游比對）', () => {
  assert.equal(analyzeLeading('希爾斯罐頭23g', FAMILY).kind, 'clean');
  const r = parseMessage('希爾斯罐頭23g');
  assert.equal(r.type, 'record');
  assert.equal(r.record.category, 'food');
  assert.equal(r.record.foodType, '罐頭');
  assert.equal(r.record.itemName, '希爾斯');
  assert.equal(r.record.amount, 23);
});

test('D. 旺財 喝水1ml（家庭無旺財）→ leadingUnknown（不得寫預設貓）', () => {
  const r = analyzeLeading('旺財 喝水1ml', FAMILY);
  assert.equal(r.kind, 'leadingUnknown');
  assert.equal(r.prefix, '旺財');
});

// 旺財非家庭貓、且與食物黏著無法分離出未知前綴 → analyzeLeading 維持 clean（不變）。
// RC1 後 parseMessage 認得食物（品項候選含未知前綴）；安全性靠下游：多貓時先 needsCatPick 問貓、
// 品項對不到時走品項確認卡，都不會靜默寫錯。
test('E. 旺財希爾斯罐頭23g → clean（黏著無法分離未知前綴，不變）；RC1 後認得食物', () => {
  assert.equal(analyzeLeading('旺財希爾斯罐頭23g', FAMILY).kind, 'clean');
  const r = parseMessage('旺財希爾斯罐頭23g');
  assert.equal(r.type, 'record');
  assert.equal(r.record.category, 'food');
  assert.equal(r.record.foodType, '罐頭');
  assert.equal(r.record.amount, 23);
});

test('F. 罐頭30 → clean，且既有通用食物格式仍正常解析', () => {
  assert.equal(analyzeLeading('罐頭30', FAMILY).kind, 'clean');
  const r = parseMessage('罐頭30');
  assert.equal(r.type, 'record');
  assert.equal(r.record.category, 'food');
  assert.equal(r.record.foodType, '罐頭');
  assert.equal(r.record.amount, 30);
});

test('旺財乾糧5（乾糧內含類別詞、旺財非貓）→ clean（不誤切、不問貓）', () => {
  assert.equal(analyzeLeading('旺財乾糧5', FAMILY).kind, 'clean');
});
