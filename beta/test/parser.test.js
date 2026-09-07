import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, matchFood, normalizeText, parseAmountToken } from '../src/parser.js';

test('normalizeText：全形轉半形、中文與數字補空白', () => {
  assert.equal(normalizeText('水２０'), '水 20');
  assert.equal(normalizeText('水20'), '水 20');
  assert.equal(normalizeText('乾糧4g'), '乾糧 4g');
  assert.equal(normalizeText('  水   20  '), '水 20');
});

test('parseAmountToken：數量與單位', () => {
  assert.deepEqual(parseAmountToken('20'), { value: 20, unit: '', hasUnit: false });
  assert.deepEqual(parseAmountToken('4g'), { value: 4, unit: 'g', hasUnit: true });
  assert.deepEqual(parseAmountToken('30ml'), { value: 30, unit: 'ml', hasUnit: true });
  assert.deepEqual(parseAmountToken('12.5克'), { value: 12.5, unit: 'g', hasUnit: true });
  assert.equal(parseAmountToken('希爾斯'), null);
});

test('驗收：水 20 → 喝水紀錄', () => {
  const intent = parseMessage('水 20');
  assert.equal(intent.type, 'record');
  assert.equal(intent.record.category, 'water');
  assert.equal(intent.record.amount, 20);
  assert.equal(intent.record.unit, 'ml');
});

test('水20（無空格）也能解析', () => {
  const intent = parseMessage('水20');
  assert.equal(intent.type, 'record');
  assert.equal(intent.record.amount, 20);
});

test('驗收：乾糧 希爾斯 4g → 食物紀錄', () => {
  const intent = parseMessage('乾糧 希爾斯 4g');
  assert.equal(intent.type, 'record');
  assert.equal(intent.record.category, 'food');
  assert.equal(intent.record.foodType, '乾糧');
  assert.equal(intent.record.itemName, '希爾斯');
  assert.equal(intent.record.amount, 4);
  assert.equal(intent.record.unit, 'g');
});

test('驗收：罐頭 皇家 30g → 罐頭紀錄', () => {
  const intent = parseMessage('罐頭 皇家 30g');
  assert.equal(intent.record.foodType, '罐頭');
  assert.equal(intent.record.itemName, '皇家');
  assert.equal(intent.record.amount, 30);
});

test('罐罐同義詞', () => {
  const intent = parseMessage('罐罐 30');
  assert.equal(intent.record.foodType, '罐頭');
});

// 「食物 ... 加水 N」＝食物＋泡食物加的水，合成單筆（addedWaterMl），不拆成兩筆。
// （裸寫的「水 N／喝水 N」改視為獨立喝水事件——見 parser-multiseg.test.mjs）
test('罐頭加水：先抽加水量、再抓克數，品名可比對', () => {
  const intent = parseMessage('罐頭 皇家 13g 加水 10');
  assert.equal(intent.record.foodType, '罐頭');
  assert.equal(intent.record.amount, 13);            // 食物克數 = 13（不是加的水 10）
  assert.equal(intent.record.addedWaterMl, 10);      // 加的水 = 10ml
  assert.equal(intent.record.itemName, '皇家');        // 品名乾淨 → 能比對到「皇家罐頭」
  const foods = [{ foodId: 'x', displayName: '皇家罐頭', brand: '', productName: '', foodType: '罐頭', isDeleted: 0 }];
  assert.equal(matchFood(foods, intent.record.itemName, intent.record.foodType).foodId, 'x');
});

test('罐頭加水：克數沒帶單位也不會被加水覆蓋（嚴格）', () => {
  const intent = parseMessage('罐頭 皇家 13 加水 10');
  assert.equal(intent.record.amount, 13);            // 先移除「加水 10」→ 剩下唯一數字 13
  assert.equal(intent.record.addedWaterMl, 10);
  assert.equal(intent.record.itemName, '皇家');
});

test('罐頭加水：小數克數＋較大加水量', () => {
  const intent = parseMessage('罐頭 皇家 14.8g 加水 28');
  assert.equal(intent.record.amount, 14.8);
  assert.equal(intent.record.addedWaterMl, 28);
  assert.equal(intent.record.itemName, '皇家');
});

test('沒加水時 addedWaterMl 為 0', () => {
  const intent = parseMessage('罐頭 皇家 30g');
  assert.equal(intent.record.amount, 30);
  assert.equal(intent.record.addedWaterMl, 0);
  assert.equal(intent.record.itemName, '皇家');
});

test('純數字（無單位、無加水）仍取最後一個數字', () => {
  const intent = parseMessage('罐頭 皇家 30');
  assert.equal(intent.record.amount, 30);
  assert.equal(intent.record.addedWaterMl, 0);
  assert.equal(intent.record.itemName, '皇家');
});

test('驗收：藥 已吃 → 用藥紀錄', () => {
  const intent = parseMessage('藥 已吃');
  assert.equal(intent.type, 'record');
  assert.equal(intent.record.category, 'med');
  assert.equal(intent.record.medStatus, '已吃');
});

test('藥 早 已吃 → 含時段', () => {
  const intent = parseMessage('藥 早 已吃');
  assert.equal(intent.record.medSlot, '早');
  assert.equal(intent.record.medStatus, '已吃');
});

test('藥 心臟藥 晚 漏餵 → 含藥名與異常狀態', () => {
  const intent = parseMessage('藥 心臟藥 晚 漏餵');
  assert.equal(intent.record.itemName, '心臟藥');
  assert.equal(intent.record.medSlot, '晚');
  assert.equal(intent.record.medStatus, '漏餵');
});

test('吐 白色泡沫 → 嘔吐紀錄', () => {
  const intent = parseMessage('吐 白色泡沫');
  assert.equal(intent.record.category, 'vomit');
  assert.equal(intent.record.note, '白色泡沫');
});

test('便 成形偏軟 → 便便紀錄', () => {
  const intent = parseMessage('便 成形偏軟');
  assert.equal(intent.record.category, 'stool');
  assert.equal(intent.record.note, '成形偏軟');
});

test('軟便（單詞本身就是描述）', () => {
  const intent = parseMessage('軟便');
  assert.equal(intent.record.category, 'stool');
  assert.equal(intent.record.note, '軟便');
});

test('精神 活動力差', () => {
  const intent = parseMessage('精神 活動力差');
  assert.equal(intent.record.category, 'mood');
  assert.equal(intent.record.note, '活動力差');
});

test('備註 今天有梳毛', () => {
  const intent = parseMessage('備註 今天有梳毛');
  assert.equal(intent.record.category, 'note');
  assert.equal(intent.record.note, '今天有梳毛');
});

test('補登：昨天 21:30 水 20', () => {
  const intent = parseMessage('昨天 21:30 水 20');
  assert.equal(intent.type, 'record');
  assert.equal(intent.record.dayOffset, -1);
  assert.equal(intent.record.time, '21:30');
  assert.equal(intent.record.amount, 20);
});

test('補登：前天 乾糧 4g', () => {
  const intent = parseMessage('前天 乾糧 4g');
  assert.equal(intent.record.dayOffset, -2);
  assert.equal(intent.record.foodType, '乾糧');
});

test('驗收：查詢指令', () => {
  assert.deepEqual(parseMessage('今天'), { type: 'query', query: 'today' });
  assert.deepEqual(parseMessage('近7天'), { type: 'query', query: 'week' });
  assert.deepEqual(parseMessage('月曆'), { type: 'query', query: 'calendar' });
  assert.deepEqual(parseMessage('回診'), { type: 'query', query: 'visit' });
  assert.deepEqual(parseMessage('網站'), { type: 'query', query: 'website' });
  assert.deepEqual(parseMessage('說明'), { type: 'query', query: 'help' });
});

test('圖文選單標籤＝送出詞，都對得上動作（自動回覆一致）', () => {
  assert.deepEqual(parseMessage('記一筆'), { type: 'query', query: 'recordMenu' });
  assert.deepEqual(parseMessage('今日記錄'), { type: 'query', query: 'today' });
  assert.deepEqual(parseMessage('給醫生看'), { type: 'query', query: 'report' });
  assert.deepEqual(parseMessage('怎麼記'), { type: 'exampleMenu' });
});

test('新增貓咪 蚵仔（含舊寫法相容）', () => {
  assert.deepEqual(parseMessage('新增貓咪 蚵仔'), { type: 'addPet', name: '蚵仔' });
  assert.deepEqual(parseMessage('新增貓貓 蚵仔'), { type: 'addPet', name: '蚵仔' });
  assert.deepEqual(parseMessage('新增毛孩 蚵仔'), { type: 'addPet', name: '蚵仔' });
});

test('缺數量 → invalid', () => {
  assert.equal(parseMessage('水').type, 'invalid');
  assert.equal(parseMessage('乾糧 希爾斯').type, 'invalid');
});

test('看不懂 → unknown', () => {
  assert.equal(parseMessage('哈囉').type, 'unknown');
  assert.equal(parseMessage('').type, 'unknown');
});

test('matchFood：名稱比對與類型加分', () => {
  const foods = [
    { foodId: 'a', displayName: '希爾斯 腎臟處方', brand: '希爾斯', productName: '腎臟處方', foodType: '乾糧', isDeleted: 0 },
    { foodId: 'b', displayName: '皇家 腸胃罐', brand: '皇家', productName: '腸胃罐', foodType: '罐頭', isDeleted: 0 },
    { foodId: 'c', displayName: '希爾斯 腸胃罐', brand: '希爾斯', productName: '腸胃罐', foodType: '罐頭', isDeleted: 0 }
  ];
  assert.equal(matchFood(foods, '希爾斯', '乾糧').foodId, 'a');
  assert.equal(matchFood(foods, '希爾斯', '罐頭').foodId, 'c');
  assert.equal(matchFood(foods, '皇家', '罐頭').foodId, 'b');
  assert.equal(matchFood(foods, '不存在的牌子', '乾糧'), null);
  assert.equal(matchFood([], '希爾斯', '乾糧'), null);
});

test('matchFood：忽略已刪除的食物', () => {
  const foods = [{ foodId: 'x', displayName: '希爾斯', brand: '', productName: '', foodType: '乾糧', isDeleted: 1 }];
  assert.equal(matchFood(foods, '希爾斯', '乾糧'), null);
});

test('體重：記一筆有日期的體重（趨勢用），不是只改欄位', () => {
  const r = parseMessage('體重 4.2');
  assert.equal(r.type, 'record');
  assert.equal(r.record.category, 'weight');
  assert.equal(r.record.amount, 4.2);
  assert.equal(parseMessage('記體重 4.5').record.amount, 4.5); // 「記體重 N」也可
});

test('引導建檔：生日', () => {
  assert.deepEqual(parseMessage('生日 2020/1/5'), { type: 'petField', field: 'birthday', value: '2020-01-05' });
  assert.equal(parseMessage('生日 亂打').value, '');
});

test('改 54 → 改最後一筆數量（fixLast）', () => {
  const r = parseMessage('改 54');
  assert.equal(r.type, 'fixLast');
  assert.equal(r.mode, 'set');
  assert.equal(r.amount, 54);
});

test('改 皇家罐頭 24 → 指定品名改食物（fixMatch，不限最後一筆）', () => {
  const r = parseMessage('改 皇家罐頭 24');
  assert.equal(r.type, 'fixMatch');
  assert.equal(r.query, '皇家罐頭');
  assert.equal(r.amount, 24);
  assert.equal(parseMessage('改 罐頭 30').query, '罐頭');
});

test('新增食物分類：生食／生肉可辨識', () => {
  assert.equal(parseMessage('生食 30').record.foodType, '生食');
  assert.equal(parseMessage('生食 30').record.amount, 30);
  assert.equal(parseMessage('生肉 25').record.foodType, '生食');
  assert.deepEqual(parseMessage('設定生食 主食生食 1.5'), { type: 'foodSetup', foodType: '生食', name: '主食生食', kcalPerGram: 1.5 });
});

test('引導建檔：食物與餵藥時段', () => {
  assert.deepEqual(parseMessage('設定罐頭 主食罐 1.1'), { type: 'foodSetup', foodType: '罐頭', name: '主食罐', kcalPerGram: 1.1 });
  assert.deepEqual(parseMessage('設定乾糧 腎處方'), { type: 'foodSetup', foodType: '乾糧', name: '腎處方', kcalPerGram: 0 });
  assert.deepEqual(parseMessage('餵藥時段 早晚').slots, ['早', '晚']);
  assert.deepEqual(parseMessage('餵藥時段 不用').slots, []);
});
