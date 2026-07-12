// 貓貓照護管家 Beta — LINE 中文指令解析（純函式，可單元測試）
//
// parseMessage(text) 回傳 intent：
//   { type: 'record', record: { category, foodType, itemName, amount, unit,
//                               medStatus, medSlot, note, dayOffset, time } }
//   { type: 'query', query: 'today' | 'week' | 'calendar' | 'visit' | 'website' | 'help' }
//   { type: 'addPet', name }
//   { type: 'invalid', reason, category }
//   { type: 'unknown' }
//
// category: water | food | med | vomit | stool | mood | note

const WATER_WORDS = new Set(['水', '喝水', '飲水', '喝', '喝了', '喝水了']);

const FOOD_TYPE_WORDS = [
  { type: '乾糧', words: ['乾糧', '飼料', '乾乾'] },
  { type: '罐頭', words: ['罐頭', '罐罐', '主食罐', '副食罐'] },
  { type: '濕食', words: ['濕食', '鮮食', '餐包', '肉泥'] },
  { type: '零食', words: ['零食', '點心'] },
  { type: '其他', words: ['其他'] }
];

const MED_WORDS = new Set(['藥', '用藥', '餵藥', '吃藥', '吃藥了', '餵藥了', '有吃藥']);
const VOMIT_WORDS = new Set(['吐', '嘔吐', '吐了', '嘔吐了']);
const STOOL_PLAIN_WORDS = new Set(['便', '大便', '便便', '大便了', '便了', '便便了', '排便', '拉了']);
const STOOL_DETAIL_WORDS = new Set(['軟便', '血便', '拉肚子', '腹瀉', '便秘', '拉稀']);
const URINE_WORDS = new Set(['尿', '尿尿', '小便', '噓噓', '尿了', '排尿']);
const SUPPLEMENT_WORDS = new Set(['營養補充', '保健品', '保健', '補充', '益生菌']);
const MOOD_WORDS = new Set(['精神']);
const MOOD_DETAIL_WORDS = new Set(['沒精神', '精神差', '活力差', '懶懶的', '沒活力']);
// 句首的動詞雜訊：吃了罐頭30g、餵了乾糧4g
const LEAD_VERBS = new Set(['吃了', '餵了', '吃', '餵', '吃掉', '餵食', '有吃', '有餵']);
const NOTE_WORDS = new Set(['備註', '筆記']);

const MED_STATUS_WORDS = [
  { status: '已吃', words: ['已吃', '已餵', '有吃', '有餵', '吃了', '餵了', 'ok'] },
  { status: '漏餵', words: ['漏餵', '漏', '忘記', '忘了', '沒餵', '沒餵到', '沒吃到'] },
  { status: '吐掉', words: ['吐掉', '吐出', '吐了'] },
  { status: '拒吃', words: ['拒吃', '不吃', '沒吃', '拒絕'] }
];

const MED_SLOT_WORDS = [
  { slot: '早', words: ['早', '早上', '早藥'] },
  { slot: '中午', words: ['中午', '午'] },
  { slot: '晚', words: ['晚', '晚上', '晚藥'] }
];

const QUERY_WORDS = [
  { query: 'today', words: ['今天', '今日', '今日確認', '今天狀況', '今日總結', '今天確認'] },
  { query: 'week', words: ['近7天', '近七天', '最近7天', '7天', '近7日', '近一週', '近一周'] },
  { query: 'calendar', words: ['月曆', '月历', '本月', '月曆紀錄', '看月曆'] },
  { query: 'visit', words: ['回診', '回诊', '看診', '看诊', '回診摘要', '給醫生', '看醫生', '看診摘要'] },
  { query: 'website', words: ['網站', '照護站', '照护站', '登入', '开网站', '開網站', '我的照護站', '開照護站'] },
  { query: 'recordMenu', words: ['紀錄', '記錄', '快速紀錄', '快速記錄', '新增', '記一下', '我要紀錄', '我要記錄'] },
  { query: 'backfill', words: ['補登', '補記', '昨天', '前天'] },
  { query: 'onboarding', words: ['安心上手', '喵爸媽安心上手', '第一次使用', '怎麼開始', '新手'] },
  { query: 'help', words: ['說明', '说明', '幫助', '帮助', 'help', '指令', '教學', '教学', '怎麼用', '怎么用', '使用說明'] }
];

// 快速紀錄選單按鈕 → 對應提示
const RECORD_PROMPT_WORDS = {
  '記吃飯': 'food', '記喝水': 'water', '記用藥': 'med', '記嘔吐': 'vomit',
  '記排便': 'stool', '記大便': 'stool', '記尿尿': 'urine', '記營養補充': 'supplement',
  '記精神': 'mood', '記備註': 'note'
};

export function normalizeText(value) {
  let text = String(value || '');
  // 全形轉半形（含全形空白）
  text = text.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  text = text.replace(/　/g, ' ');
  // 中文字與數字相連時補空白：水20 → 水 20、乾糧4g → 乾糧 4g
  text = text.replace(/([一-鿿])(\d)/g, '$1 $2');
  text = text.replace(/(\d(?:[a-zA-Z.]*)?)([一-鿿])/g, '$1 $2');
  return text.trim().replace(/\s+/g, ' ');
}

export function parseAmountToken(token) {
  const match = String(token || '').match(/^(\d+(?:\.\d+)?)(g|克|公克|ml|毫升|cc|c\.c\.?)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unitRaw = (match[2] || '').toLowerCase();
  const isMl = ['ml', '毫升', 'cc', 'c.c', 'c.c.'].includes(unitRaw);
  return { value, unit: unitRaw ? (isMl ? 'ml' : 'g') : '', hasUnit: Boolean(unitRaw) };
}

function matchWordList(token, list) {
  for (const entry of list) {
    if (entry.words.includes(token)) return entry;
  }
  return null;
}

function extractAmount(tokens, defaultUnit) {
  // 有多個數字時，優先挑「有明確單位」的（例如 13g、20ml），避免挑錯（皇家 13g 水 10 → 取 13 而非 10）
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const parsed = parseAmountToken(tokens[i]);
    if (parsed && parsed.value > 0 && parsed.hasUnit) {
      const rest = tokens.slice(0, i).concat(tokens.slice(i + 1));
      return { amount: parsed.value, unit: parsed.unit || defaultUnit, rest };
    }
  }
  // 沒有帶單位的數字時，退回最後一個純數字
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const parsed = parseAmountToken(tokens[i]);
    if (parsed && parsed.value > 0) {
      const rest = tokens.slice(0, i).concat(tokens.slice(i + 1));
      return { amount: parsed.value, unit: parsed.unit || defaultUnit, rest };
    }
  }
  return { amount: 0, unit: defaultUnit, rest: tokens };
}

// 食物品名清洗：把多餘的數字（含單位）與「水」等雜訊字拿掉，避免品名比對失敗；
// 拿掉的內容原樣保留下來，一律不臆測、不丟失（回傳給呼叫端塞進備註）。
const FOOD_NAME_NOISE = new Set(['水', '加水', '清水', '泡水']);
function cleanFoodName(tokens) {
  const nameTokens = [];
  const dropped = [];
  for (const token of tokens) {
    if (parseAmountToken(token) || FOOD_NAME_NOISE.has(token)) dropped.push(token);
    else nameTokens.push(token);
  }
  return { itemName: nameTokens.join(' '), dropped: dropped.join(' ') };
}

function emptyRecord() {
  return {
    category: '',
    foodType: '',
    itemName: '',
    amount: 0,
    unit: '',
    medStatus: '',
    medSlot: '',
    note: '',
    dayOffset: 0,
    time: ''
  };
}

export function parseMessage(rawText) {
  const text = normalizeText(rawText);
  if (!text) return { type: 'unknown' };

  // 查詢詞同時比對「去空白」版本（normalizeText 會把「近7天」拆成「近 7 天」）
  const compact = text.replace(/ /g, '');
  if (RECORD_PROMPT_WORDS[compact]) {
    return { type: 'recordPrompt', kind: RECORD_PROMPT_WORDS[compact] };
  }
  const candidates = [text, text.toLowerCase(), compact, compact.toLowerCase()];
  for (const entry of QUERY_WORDS) {
    if (candidates.some((candidate) => entry.words.includes(candidate))) {
      return { type: 'query', query: entry.query };
    }
  }

  // 「新增貓咪」為主，保留「新增毛孩」「新增貓貓」相容
  const addPetMatch = text.match(/^新增(?:貓咪|貓貓|毛孩)\s*(.+)$/);
  if (addPetMatch) {
    return { type: 'addPet', name: addPetMatch[1].trim() };
  }

  // 引導建檔：按鈕觸發的步驟
  if (['範例', '照著打打看', '怎麼記', '怎麼打', '範例指令', '打打看'].includes(compact)) return { type: 'exampleMenu' };
  if (['補資料', '補充資料', '補充貓咪資料', '貓咪資料', '完善資料'].includes(compact)) return { type: 'petDataLink' };
  if (['幫貓貓建檔', '開始建檔', '建立貓咪檔案'].includes(compact)) return { type: 'petNamePrompt' };
  if (['記體重', '補體重'].includes(compact)) return { type: 'petFieldPrompt', field: 'weightKg' };
  if (['記生日', '補生日', '記年齡', '補年齡'].includes(compact)) return { type: 'petFieldPrompt', field: 'birthday' };
  if (['補體重生日', '補體重年齡'].includes(compact)) return { type: 'petExtraMenu' };
  const foodPromptMatch = compact.match(/^設定(罐頭|乾糧|濕食|零食)$/);
  if (foodPromptMatch) return { type: 'foodSetupPrompt', foodType: foodPromptMatch[1] };
  if (['稍後再說', '先跳過', '跳過'].includes(compact)) return { type: 'skipStep' };
  if (compact === '完成設定') return { type: 'setupDone' };

  // 引導建檔：常吃的食物與餵藥時段
  if (['設定食物', '建立食物', '新增食物', '設定常吃的食物'].includes(compact)) {
    return { type: 'foodSetupMenu' };
  }
  const foodSetupMatch = text.match(/^(?:設定|新增)(罐頭|乾糧|濕食|零食)\s+(.+?)(?:\s+([0-9.]+))?$/);
  if (foodSetupMatch) {
    return {
      type: 'foodSetup',
      foodType: foodSetupMatch[1],
      name: foodSetupMatch[2].trim(),
      kcalPerGram: foodSetupMatch[3] ? Number(foodSetupMatch[3]) : 0
    };
  }
  if (['設定保健品', '設定保健品藥', '保健品藥'].includes(compact)) return { type: 'medAskMenu' };
  if (['記保健品', '記一個保健品', '建保健品'].includes(compact)) return { type: 'medNamePrompt' };
  if (['設定餵藥', '餵藥設定', '設定用藥'].includes(compact)) {
    return { type: 'medSetupMenu' };
  }
  const medSlotsMatch = text.match(/^餵藥時段\s*(.*)$/);
  if (medSlotsMatch) {
    const raw = medSlotsMatch[1];
    let slots = [];
    if (!/無|不用|沒有|先不/.test(raw)) {
      if (raw.includes('早')) slots.push('早');
      if (raw.includes('中')) slots.push('中午');
      if (raw.includes('晚')) slots.push('晚');
    }
    return { type: 'medSlots', slots };
  }

  // 貓咪基本資料（LINE 引導建檔）：體重 4.2、生日 2020-01-01
  const weightMatch = text.match(/^體重\s*([0-9.]+)\s*(?:kg|公斤)?$/i);
  if (weightMatch) {
    return { type: 'petField', field: 'weightKg', value: Number(weightMatch[1]) };
  }
  const ageMatch = text.match(/^年齡\s*(\d{1,2})\s*歲?$/);
  if (ageMatch) {
    return { type: 'petField', field: 'age', value: Number(ageMatch[1]) };
  }
  const birthdayMatch = text.match(/^生日\s*(.*)$/);
  if (birthdayMatch) {
    const raw = birthdayMatch[1].trim();
    const dateMatch = raw.match(/^(\d{4})[年\/\-.](\d{1,2})[月\/\-.](\d{1,2})日?$/);
    const value = dateMatch
      ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
      : '';
    return { type: 'petField', field: 'birthday', value };
  }

  // 修正上一筆：改 54 / 改成54（改數量）、剩 20 / 沒吃完剩20（扣掉）、刪除（刪上一筆）
  if (['刪除', '刪掉', '刪除上一筆', '刪上一筆', '刪除剛剛', '刪掉剛剛'].includes(compact)) {
    return { type: 'deleteLast' };
  }
  const leftoverFix = compact.match(/^(?:沒吃完|沒喝完)?剩下?(\d+(?:\.\d+)?)(?:g|克|公克|ml|毫升|cc)?$/i);
  if (leftoverFix) {
    return { type: 'fixLast', mode: 'subtract', amount: Number(leftoverFix[1]) };
  }
  const editFix = compact.match(/^(?:改成?|修改|更正)(\d+(?:\.\d+)?)(?:g|克|公克|ml|毫升|cc)?$/i);
  if (editFix) {
    return { type: 'fixLast', mode: 'set', amount: Number(editFix[1]) };
  }
  if (['記錯', '記錯了', '打錯', '打錯了', '輸入錯誤', '修改'].includes(compact)) {
    return { type: 'fixHint' };
  }

  let tokens = text.split(' ');

  // 時間前綴：昨天 / 前天 / HH:MM（可組合，例如「昨天 21:30 水 20」）
  let dayOffset = 0;
  let time = '';
  while (tokens.length > 0) {
    const head = tokens[0];
    if (head === '昨天' && tokens.length > 1) { dayOffset = -1; tokens = tokens.slice(1); continue; }
    if (head === '前天' && tokens.length > 1) { dayOffset = -2; tokens = tokens.slice(1); continue; }
    if (head === '今天' && tokens.length > 1) { tokens = tokens.slice(1); continue; }
    const timeMatch = head.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch && tokens.length > 1) {
      const hour = Number(timeMatch[1]);
      const minute = Number(timeMatch[2]);
      if (hour < 24 && minute < 60) {
        time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        tokens = tokens.slice(1);
        continue;
      }
    }
    break;
  }

  if (tokens.length === 0) return { type: 'unknown' };

  // 「吃了 罐頭 30g」「餵了 乾糧 4g」→ 剝掉開頭動詞
  if (tokens.length > 1 && LEAD_VERBS.has(tokens[0])) {
    tokens = tokens.slice(1);
  } else if (tokens.length >= 1) {
    // 黏在一起的也切：「吃了罐頭 30g」→「罐頭 30g」
    for (const verb of ['吃了', '餵了', '吃掉', '餵食', '有吃', '有餵']) {
      if (tokens[0].length > verb.length && tokens[0].startsWith(verb)) {
        tokens = [tokens[0].slice(verb.length), ...tokens.slice(1)];
        break;
      }
    }
  }

  const head = tokens[0];
  const rest = tokens.slice(1);
  const record = emptyRecord();
  record.dayOffset = dayOffset;
  record.time = time;

  // 喝水
  if (WATER_WORDS.has(head)) {
    const { amount, rest: leftover } = extractAmount(rest, 'ml');
    if (!amount) return { type: 'invalid', reason: 'missing_amount', category: 'water' };
    record.category = 'water';
    record.amount = amount;
    record.unit = 'ml';
    record.note = leftover.join(' ');
    return { type: 'record', record };
  }

  // 食物
  const foodEntry = matchWordList(head, FOOD_TYPE_WORDS);
  if (foodEntry) {
    const { amount, rest: leftover } = extractAmount(rest, 'g');
    if (!amount) return { type: 'invalid', reason: 'missing_amount', category: 'food' };
    record.category = 'food';
    record.foodType = foodEntry.type;
    record.amount = amount;
    record.unit = 'g';
    const { itemName, dropped } = cleanFoodName(leftover);
    record.itemName = itemName;
    if (dropped) record.note = dropped; // 多打的數字/「水」等原樣保留，不臆測成水量
    return { type: 'record', record };
  }

  // 藥物：藥 [名稱] [早|中午|晚] [已吃|漏餵|吐掉|拒吃]
  if (MED_WORDS.has(head)) {
    const nameParts = [];
    for (const token of rest) {
      const slotEntry = matchWordList(token, MED_SLOT_WORDS);
      if (slotEntry && !record.medSlot) { record.medSlot = slotEntry.slot; continue; }
      const statusEntry = matchWordList(token.toLowerCase(), MED_STATUS_WORDS);
      if (statusEntry && !record.medStatus) { record.medStatus = statusEntry.status; continue; }
      nameParts.push(token);
    }
    record.category = 'med';
    record.medStatus = record.medStatus || '已吃';
    record.itemName = nameParts.join(' ');
    return { type: 'record', record };
  }

  // 嘔吐
  if (VOMIT_WORDS.has(head)) {
    record.category = 'vomit';
    record.note = rest.join(' ');
    return { type: 'record', record };
  }

  // 便便（「軟便」「拉肚子」等本身就是描述）
  if (STOOL_PLAIN_WORDS.has(head) || STOOL_DETAIL_WORDS.has(head)) {
    record.category = 'stool';
    const detail = STOOL_DETAIL_WORDS.has(head) ? [head, ...rest] : rest;
    record.note = detail.join(' ');
    return { type: 'record', record };
  }

  // 尿尿
  if (URINE_WORDS.has(head)) {
    record.category = 'urine';
    record.note = rest.join(' ');
    return { type: 'record', record };
  }

  // 營養補充（保健品）：可帶名稱，例如「營養補充 益生菌」
  if (SUPPLEMENT_WORDS.has(head)) {
    record.category = 'supplement';
    record.itemName = rest.join(' ');
    record.note = '';
    return { type: 'record', record };
  }

  // 精神（「沒精神」「活力差」本身就是描述）
  if (MOOD_WORDS.has(head) || MOOD_DETAIL_WORDS.has(head)) {
    record.category = 'mood';
    const detail = MOOD_DETAIL_WORDS.has(head) ? [head, ...rest] : rest;
    record.note = detail.join(' ');
    return { type: 'record', record };
  }

  // 備註
  if (NOTE_WORDS.has(head)) {
    const note = rest.join(' ');
    if (!note) return { type: 'invalid', reason: 'missing_note', category: 'note' };
    record.category = 'note';
    record.note = note;
    return { type: 'record', record };
  }

  return { type: 'unknown' };
}

// 依名稱在食物清單中找最接近的一筆（displayName / brand / productName，優先同類型）
export function matchFood(foods, itemName, foodType) {
  const name = String(itemName || '').trim().toLowerCase();
  if (!name) return null;

  let best = null;
  let bestScore = 0;

  for (const food of foods || []) {
    if (food.isDeleted) continue;
    const displayName = String(food.displayName || '').toLowerCase();
    const brand = String(food.brand || '').toLowerCase();
    const productName = String(food.productName || '').toLowerCase();
    const combined = (brand + productName).trim();

    let score = 0;
    if (name === displayName || name === combined || (productName && name === productName) || (brand && name === brand)) {
      score = 100;
    } else if (displayName && (displayName.includes(name) || name.includes(displayName))) {
      score = 60;
    } else if (brand && (brand.includes(name) || name.includes(brand))) {
      score = 50;
    } else if (productName && (productName.includes(name) || name.includes(productName))) {
      score = 50;
    }

    if (score === 0) continue;
    if (foodType && food.foodType === foodType) score += 20;
    if (score > bestScore) {
      best = food;
      bestScore = score;
    }
  }

  return best;
}
