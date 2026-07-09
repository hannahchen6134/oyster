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

const WATER_WORDS = new Set(['水', '喝水', '飲水']);

const FOOD_TYPE_WORDS = [
  { type: '乾糧', words: ['乾糧', '飼料', '乾乾'] },
  { type: '罐頭', words: ['罐頭', '罐罐', '主食罐', '副食罐'] },
  { type: '濕食', words: ['濕食', '鮮食', '餐包', '肉泥'] },
  { type: '零食', words: ['零食', '點心'] },
  { type: '其他', words: ['其他'] }
];

const MED_WORDS = new Set(['藥', '用藥', '餵藥', '吃藥']);
const VOMIT_WORDS = new Set(['吐', '嘔吐']);
const STOOL_PLAIN_WORDS = new Set(['便', '大便', '便便']);
const STOOL_DETAIL_WORDS = new Set(['軟便', '血便', '拉肚子', '腹瀉', '便秘']);
const MOOD_WORDS = new Set(['精神']);
const NOTE_WORDS = new Set(['備註', '筆記']);

const MED_STATUS_WORDS = [
  { status: '已吃', words: ['已吃', '已餵', '有吃', '有餵', '吃了', '餵了', 'ok'] },
  { status: '漏餵', words: ['漏餵', '漏', '忘記', '忘了', '沒餵'] },
  { status: '吐掉', words: ['吐掉', '吐出', '吐了'] },
  { status: '拒吃', words: ['拒吃', '不吃', '沒吃', '拒絕'] }
];

const MED_SLOT_WORDS = [
  { slot: '早', words: ['早', '早上', '早藥'] },
  { slot: '中午', words: ['中午', '午'] },
  { slot: '晚', words: ['晚', '晚上', '晚藥'] }
];

const QUERY_WORDS = [
  { query: 'today', words: ['今天', '今日'] },
  { query: 'week', words: ['近7天', '近七天', '最近7天', '7天', '近7日', '近一週', '近一周'] },
  { query: 'calendar', words: ['月曆', '月历', '本月'] },
  { query: 'visit', words: ['回診', '回诊', '看診', '看诊'] },
  { query: 'website', words: ['網站', '照護站', '照护站', '登入', '开网站', '開網站'] },
  { query: 'help', words: ['說明', '说明', '幫助', '帮助', 'help', '指令', '教學', '教学', '怎麼用', '怎么用'] }
];

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
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const parsed = parseAmountToken(tokens[i]);
    if (parsed && parsed.value > 0) {
      const rest = tokens.slice(0, i).concat(tokens.slice(i + 1));
      return { amount: parsed.value, unit: parsed.unit || defaultUnit, rest };
    }
  }
  return { amount: 0, unit: defaultUnit, rest: tokens };
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
    record.itemName = leftover.join(' ');
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

  // 精神
  if (MOOD_WORDS.has(head)) {
    record.category = 'mood';
    record.note = rest.join(' ');
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
