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
  { type: '濕糧', words: ['濕糧'] },
  { type: '濕食', words: ['濕食', '鮮食', '餐包', '肉泥'] },
  { type: '生食', words: ['生食', '生肉'] },
  { type: '零食', words: ['零食', '點心'] },
  { type: '其他', words: ['其他'] }
];

const MED_WORDS = new Set(['藥', '用藥', '餵藥', '吃藥', '吃藥了', '餵藥了', '有吃藥']);
const VOMIT_WORDS = new Set(['吐', '嘔吐', '吐了', '嘔吐了']);
const STOOL_PLAIN_WORDS = new Set(['便', '大便', '便便', '大便了', '便了', '便便了', '排便', '拉了']);
const STOOL_DETAIL_WORDS = new Set(['軟便', '血便', '拉肚子', '腹瀉', '便秘', '拉稀']);
const URINE_WORDS = new Set(['尿', '尿尿', '小便', '噓噓', '尿了', '排尿']);
const SUPPLEMENT_WORDS = new Set(['營養補充', '保健品', '保健', '補充', '益生菌']);
// 只有「通用類別詞」才用來切段；像「益生菌」是品名，不該把它從前面的營養補充切開
const SUPPLEMENT_HEAD_WORDS = new Set(['營養補充', '保健品', '保健', '補充']);
const MOOD_WORDS = new Set(['精神']);
// 照護處置：疫苗、除蟲（醫生回顧時要看得到的大事）
const VACCINE_WORDS = new Set(['疫苗', '打疫苗', '預防針', '打了疫苗']);
const DEWORM_WORDS = new Set(['除蟲', '驅蟲', '除蚤', '驅蟲藥', '除蟲藥']);
const MOOD_DETAIL_WORDS = new Set(['沒精神', '精神差', '活力差', '懶懶的', '沒活力']);
// 句首的動詞雜訊：吃了罐頭30g、餵了乾糧4g
const LEAD_VERBS = new Set(['吃了', '餵了', '吃', '餵', '吃掉', '餵食', '有吃', '有餵']);
const NOTE_WORDS = new Set(['備註', '筆記']);
// 純單位詞：食物品名不該把它們留下來（例如「乾糧 34 克 加水 14 克」剝完剩「克 克」）
const UNIT_ONLY_WORDS = new Set(['克', '公克', 'g', 'ml', '毫升', 'cc', '公斤', 'kg']);
// 語音常見連接詞：僅在「後方緊接一個新的照護事件詞」時才當分隔（保守，不粗暴全域替換）
const CONNECTOR_WORDS = ['然後', '接著', '再'];

const MED_STATUS_WORDS = [
  { status: '已吃', words: ['已吃', '已餵', '有吃', '有餵', '吃了', '餵了', 'ok'] },
  { status: '漏餵', words: ['未餵', '未吃', '漏餵', '漏', '忘記', '忘了', '沒餵', '沒餵到', '沒吃到'] },
  { status: '吐掉', words: ['吐掉', '吐出', '吐了'] },
  { status: '拒吃', words: ['拒吃', '不吃', '沒吃', '拒絕'] }
];

const MED_SLOT_WORDS = [
  { slot: '早', words: ['早', '早上', '早藥'] },
  { slot: '中午', words: ['中午', '午'] },
  { slot: '晚', words: ['晚', '晚上', '晚藥'] }
];

const QUERY_WORDS = [
  { query: 'today', words: ['今天', '今日', '今日記錄', '看今日記錄', '今日紀錄', '今日確認', '今天狀況', '今日總結', '今天確認'] },
  { query: 'handoff', words: ['交班', '今日交班', '交班摘要', '交接'] },
  { query: 'week', words: ['近7天', '近七天', '最近7天', '7天', '近7日', '近一週', '近一周'] },
  { query: 'calendar', words: ['月曆', '月历', '本月', '月曆紀錄', '看月曆'] },
  { query: 'recent', words: ['回顧', '紀錄回顧', '記錄回顧', '最近紀錄', '最近記錄', '近期紀錄', '檢查紀錄'] },
  { query: 'visit', words: ['回診', '回诊', '看診', '看诊', '回診摘要', '給醫生', '給醫生看', '看醫生', '看診摘要'] },
  { query: 'website', words: ['網站', '照護站', '照护站', '登入', '开网站', '開網站', '我的照護站', '開照護站'] },
  { query: 'recordMenu', words: ['記一筆', '紀錄', '記錄', '快速紀錄', '快速記錄', '新增', '記一下', '我要紀錄', '我要記錄'] },
  { query: 'recordButtons', words: ['按鈕記錄', '按鈕紀錄', '按鈕模式', '用按鈕', '按鈕點選', '改用按鈕點選'] },
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

// ── RC2：中文數字（僅在數量上下文轉阿拉伯數字，避免全句誤轉）──
function cnToArabic(s) {
  const D = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const U = { 十: 10, 百: 100 };
  let section = 0, num = 0, seen = false;
  for (const ch of String(s)) {
    if (ch in D) { num = D[ch]; seen = true; }
    else if (ch in U) { section += (num || 1) * U[ch]; num = 0; seen = true; }
    else return null;
  }
  return seen ? section + num : null;
}
const CN_RUN = '[零一二兩三四五六七八九十百]+';
const CN_UNIT = 'g|ml|cc|c\\.c\\.?|公克|克|毫升';
const CN_TYPE_ANCHOR = FOOD_TYPE_WORDS.flatMap((e) => e.words).sort((a, b) => b.length - a.length).join('|');
const CN_WATER_ANCHOR = '喝水|飲水|加水|清水|泡水|兌水|水|喝';
// 中文數字要被視為「完整數量」的右界（單位／水詞／空白／數字／句尾）——避免「三花貓」「一半」的三、一誤轉
const CN_RIGHT_BOUND = `(?=${CN_UNIT}|${CN_WATER_ANCHOR}|$|\\s|\\d)`;
const CN_NUM_SET = new Set('零一二兩三四五六七八九十百');
const CN_RE_A = new RegExp(`(${CN_RUN})(${CN_UNIT})`, 'gi');
const CN_RE_B = new RegExp(`(${CN_TYPE_ANCHOR}|${CN_WATER_ANCHOR})(${CN_RUN})${CN_RIGHT_BOUND}`, 'g');
const CN_RE_C = new RegExp(`(${CN_RUN})(${CN_WATER_ANCHOR})`, 'g');
// D：品名（中文，非數字字）＋結尾中文數字（皇家三十三、罐頭皇家三十三）——右界限句尾/空白/單位，避免「三花貓」「第三次」
const CN_RE_D = new RegExp(`([一-鿿])(${CN_RUN})(?=${CN_UNIT}|$|\\s)`, 'g');
function convertCnNumbers(text) {
  let t = text;
  // A：中文數字＋單位（三十三克、八毫升）
  t = t.replace(CN_RE_A, (m, n, u) => { const v = cnToArabic(n); return v == null ? m : ` ${v} ${u} `; });
  // B：類型/水詞＋中文數字（罐頭三十三、水八），且右界是完整數量
  t = t.replace(CN_RE_B, (m, w, n) => { const v = cnToArabic(n); return v == null ? m : `${w} ${v} `; });
  // C：中文數字＋水詞（三十三水）
  t = t.replace(CN_RE_C, (m, n, w) => { const v = cnToArabic(n); return v == null ? m : ` ${v} ${w} `; });
  // D：品名尾隨中文數字（前一字是中文但非數字字，才不會把純數字串重切）
  t = t.replace(CN_RE_D, (m, pre, n) => { if (CN_NUM_SET.has(pre)) return m; const v = cnToArabic(n); return v == null ? m : `${pre} ${v} `; });
  return t;
}

export function normalizeText(value) {
  let text = String(value || '');
  // 全形轉半形（含全形空白）
  text = text.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  text = text.replace(/　/g, ' ');
  // RC2：中文數字→阿拉伯（僅數量上下文，非全句）
  text = convertCnNumbers(text);
  // 中文字與數字相連時補空白：水20 → 水 20、乾糧4g → 乾糧 4g
  text = text.replace(/([一-鿿])(\d)/g, '$1 $2');
  text = text.replace(/(\d(?:[a-zA-Z.]*)?)([一-鿿])/g, '$1 $2');
  // RC3：中文單位詞黏在後字時補空白（33克水8 → 33 克 水 8、8毫升早藥 → 8 毫升 早藥）
  text = text.replace(/(公克|克|毫升|cc)([^\s\d])/g, '$1 $2');
  // RC3：水事件詞黏在中文名後、且後接數量（皇家水8 的「水8」）→ 在水前補空白；
  //      品名裡的水（水解蛋白：水後非數字）不動；加水/喝水/泡水… 的水不切（前一字被排除）
  text = text.replace(/([^\s加喝泡清兌飲\d])(水)(?=\s*\d)/g, '$1 $2');
  // 逗號、頓號視為段落分隔（語音/打字常見）；換行已由下方 \s+ 收成空白
  text = text.replace(/[,、]/g, ' ');
  // 「加水/清水/泡水/兌水」與前後字分開，避免「克加水」黏成一詞、把加水量抓錯或漏掉
  text = text.replace(/(加水|清水|泡水|兌水)/g, ' $1 ');
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

// 「食物額外加水」：只認明講「加水/清水/泡水/兌水 + 數字」才當 addedWater（ml）。
// 裸寫的「水14／喝水14」一律視為獨立喝水事件（不再自動當成泡罐頭的水），語意更精準、不誤併。
const FOOD_WATER_WORDS = new Set(['加水', '清水', '泡水', '兌水']);
function parseFoodExtras(tokens) {
  const toks = [...tokens];
  let addedWaterMl = 0;
  for (let i = 0; i < toks.length; i += 1) {
    if (!FOOD_WATER_WORDS.has(toks[i])) continue;
    const next = parseAmountToken(toks[i + 1]);
    if (next && next.value > 0) {
      addedWaterMl += next.value;
      toks.splice(i, 2); // 移除「水」與其後的數字
    } else {
      toks.splice(i, 1); // 只有「水」沒接數字 → 當雜訊移除
    }
    i -= 1;
  }
  return { tokens: toks, addedWaterMl };
}

function emptyRecord() {
  return {
    category: '',
    foodType: '',
    itemName: '',
    amount: 0,
    unit: '',
    addedWaterMl: 0,
    medStatus: '',
    medSlot: '',
    note: '',
    dayOffset: 0,
    time: ''
  };
}

// 所有食物類型詞（含別名）攤平、由長到短排序，供「子字串」偵測用（先比長的：主食罐 優先於 罐）
const FLAT_FOOD_TYPE_WORDS = FOOD_TYPE_WORDS
  .flatMap((e) => e.words.map((w) => ({ type: e.type, word: w })))
  .sort((a, b) => b.word.length - a.word.length);
// token 是否「內含」食物類型詞（皇家罐頭／希爾斯乾糧）——用來把多個黏字食物（皇家罐頭33 希爾斯乾糧10）切成不同段。
// 排除「其他」這個 catch-all，避免「其他事情」等被誤當食物切段。
const SPLIT_FOOD_TYPE_WORDS = FLAT_FOOD_TYPE_WORDS.filter((e) => e.type !== '其他');
function foodTypeInToken(token) {
  const t = String(token || '');
  return SPLIT_FOOD_TYPE_WORDS.some((e) => t.includes(e.word));
}

// RC3：黏字用藥事件（早藥吃了／晚藥已吃／藥早吃了）——必須「含藥」且有時段或狀態才算，
// 品名含「藥」但無時段/狀態（藥膳罐頭）不誤判成用藥。回傳 {medSlot, medStatus} 或 null。
function parseMedToken(token) {
  const t = String(token || '');
  if (!t.includes('藥')) return null;
  let medSlot = '';
  for (const entry of MED_SLOT_WORDS) { if (entry.words.some((w) => t.includes(w))) { medSlot = entry.slot; break; } }
  let medStatus = '';
  for (const entry of MED_STATUS_WORDS) { if (entry.words.some((w) => t.includes(w))) { medStatus = entry.status; break; } }
  if (!medSlot && !medStatus) return null; // 只有「藥」、無時段無狀態 → 不當用藥（品名含藥字）
  return { medSlot, medStatus: medStatus || '已吃', itemName: '' };
}

// RC1：類型詞與品名黏著或倒序（罐頭皇家33／皇家罐頭33／皇家33罐頭）時，仍解析出
// {類型, 品名候選, 數量}。只用「類型詞＋數字＋既有單位規則」，品名一律當剩餘文字，不寫死任何品牌。
// 回傳 { type:'record', record } 或 null（無法當單一食物 → 交由呼叫端續判斷）。
function parseFoodExpression(tokens, dayOffset, time) {
  const { tokens: afterWater, addedWaterMl } = parseFoodExtras(tokens);
  const { amount, rest } = extractAmount(afterWater, 'g');
  if (!amount) return null; // 沒有數量 → 不當食物，避免把任意詞硬歸類成食物
  // 品名 blob＝剩餘 token 去掉純數字與純單位詞後相接（罐頭皇家 / 克 這種單位不進品名）
  const nameTokens = rest.filter((t) => !parseAmountToken(t) && !UNIT_ONLY_WORDS.has(t.toLowerCase()));
  const blob = nameTokens.join('');
  if (!blob) return null;
  // 在 blob 中找任一類型詞（子字串、由長到短）
  let hit = null;
  for (const e of FLAT_FOOD_TYPE_WORDS) {
    const i = blob.indexOf(e.word);
    if (i >= 0) { hit = { type: e.type, word: e.word, i }; break; }
  }
  if (!hit) return null;
  // 品名候選＝blob 去掉「這一個」類型詞（罐頭皇家→皇家、皇家罐頭→皇家、水解蛋白罐頭→水解蛋白）
  // RC3 後：真正的水/藥事件已在切段階段被切成獨立段落，故品名裡的「水」（水解蛋白）可安全保留。
  const brand = (blob.slice(0, hit.i) + blob.slice(hit.i + hit.word.length)).trim();
  const record = emptyRecord();
  record.dayOffset = dayOffset;
  record.time = time;
  record.category = 'food';
  record.foodType = hit.type;
  record.amount = amount;
  record.unit = 'g';
  record.addedWaterMl = addedWaterMl;
  record.itemName = brand;
  return { type: 'record', record };
}

// 無任何類型詞、但有「品名＋數量」（皇家33）→ 中性候選，交 index.js 反查 food_items。
// parser 不查資料庫、不臆測這是不是食物、更不臆測類型；只結構化描述「疑似品項＋數量」。
function parseItemLookupCandidate(tokens, dayOffset, time) {
  const { tokens: afterWater, addedWaterMl } = parseFoodExtras(tokens);
  const { amount, rest } = extractAmount(afterWater, 'g');
  if (!amount) return null;
  const nameTokens = rest.filter((t) => !parseAmountToken(t) && !UNIT_ONLY_WORDS.has(t.toLowerCase()));
  const itemName = nameTokens.join(' ').trim();
  // RC3 後：品名含「水」（水解蛋白）可保留——真正的水事件已在切段階段被切走。
  if (!itemName || LEAD_VERBS.has(itemName)) return null;
  return { type: 'item_lookup_candidate', itemName, amount, unit: 'g', addedWaterMl, dayOffset, time };
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
  const foodPromptMatch = compact.match(/^設定(罐頭|乾糧|濕食|濕糧|生食|零食)$/);
  if (foodPromptMatch) return { type: 'foodSetupPrompt', foodType: foodPromptMatch[1] };
  if (['稍後再說', '先跳過', '跳過'].includes(compact)) return { type: 'skipStep' };
  if (compact === '完成設定') return { type: 'setupDone' };

  // 引導建檔：常吃的食物與餵藥時段
  if (['設定食物', '建立食物', '新增食物', '設定常吃的食物'].includes(compact)) {
    return { type: 'foodSetupMenu' };
  }
  const foodSetupMatch = text.match(/^(?:設定|新增)(罐頭|乾糧|濕食|濕糧|生食|零食)\s+(.+?)(?:\s+([0-9.]+))?$/);
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

  // 體重：「體重 4.2」「記體重 4.2」→ 記一筆有日期的體重（給醫生看趨勢），並同步更新目前體重。
  const weightMatch = text.match(/^(?:記|補)?體重\s*([0-9.]+)\s*(?:kg|公斤)?$/i);
  if (weightMatch) {
    return { type: 'record', record: { category: 'weight', amount: Number(weightMatch[1]), unit: 'kg', itemName: '', foodType: '', addedWaterMl: 0, medStatus: '', medSlot: '', note: '', dayOffset: 0, time: '' } };
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
  // 「改 皇家罐頭 24」：指定品名/類型，改最近一筆符合的食物（不限於最後一筆）
  const editMatch = compact.match(/^(?:改成?|修改|更正)(.+?)(\d+(?:\.\d+)?)(?:g|克|公克|ml|毫升|cc)?$/i);
  if (editMatch) {
    return { type: 'fixMatch', query: editMatch[1].trim(), amount: Number(editMatch[2]) };
  }
  if (['記錯', '記錯了', '打錯', '打錯了', '輸入錯誤', '修改'].includes(compact)) {
    return { type: 'fixHint' };
  }

  // 保守處理語音連接詞（然後/接著/再）：只有後方緊接一個事件詞時，才把它當段落分隔
  let tokens = splitConnectorsAtEvents(text).split(' ');

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
    // 黏在一起的也切：「吃了罐頭 30g」→「罐頭 30g」、「吃皇家罐頭33」→「皇家罐頭33」（長的動詞先比）
    for (const verb of ['吃了', '餵了', '吃掉', '餵食', '有吃', '有餵', '吃', '餵']) {
      if (tokens[0].length > verb.length && tokens[0].startsWith(verb)) {
        tokens = [tokens[0].slice(verb.length), ...tokens.slice(1)];
        break;
      }
    }
  }

  // 一則訊息可含多筆：以「類別詞」為界切段，各段獨立解析後一起記錄
  // （例如「水20 乾糧4 藥早已吃」＝三筆）。只有單一段落時走原本單筆流程、沿用原訊息。
  const segments = splitSegments(tokens);
  if (segments.length > 1) {
    const records = [];
    const invalids = [];
    const candidates = []; // 無類別詞品項候選（皇家水解蛋白33）——交呼叫端反查 food_items
    const unparsed = []; // 無法解析的段落「原片段文字」——保留、不靜默丟棄
    for (const seg of segments) {
      const intent = parseSegment(seg, dayOffset, time);
      if (intent.type === 'record') records.push(intent.record);
      else if (intent.type === 'item_lookup_candidate') candidates.push(intent); // 無類別詞品項候選：交呼叫端反查，不丟成 unparsed
      else if (intent.type === 'invalid') { invalids.push(intent); unparsed.push(seg.join(' ')); }
      else unparsed.push(seg.join(' ')); // unknown 段：保留原文，交由呼叫端明列「尚未記錄」
    }
    if (records.length || candidates.length) return { type: 'multiRecord', records, invalids, unparsed, candidates };
    // 全部都不成立 → 落回單段解析，沿用原本的錯誤訊息
  }

  return parseSegment(tokens, dayOffset, time);
}

// 判斷 token 是否為「類別起始詞」（用來把一則訊息切成多筆）
function isSegmentHead(token) {
  if (
    WATER_WORDS.has(token) || MED_WORDS.has(token) || VOMIT_WORDS.has(token)
    || STOOL_PLAIN_WORDS.has(token) || STOOL_DETAIL_WORDS.has(token) || URINE_WORDS.has(token)
    || SUPPLEMENT_HEAD_WORDS.has(token) || MOOD_WORDS.has(token) || MOOD_DETAIL_WORDS.has(token)
    || NOTE_WORDS.has(token)
  ) return true;
  // 食物段起始：類型詞（含黏在品名裡的，如 皇家罐頭／希爾斯乾糧）——讓多個食物各自成段
  if (foodTypeInToken(token)) return true;
  // RC3：黏字用藥事件（早藥吃了）也是段落起始，才不會被吞進前一段（水）的備註
  return Boolean(parseMedToken(token));
}

// 以「類別起始詞」為界，把 token 切成多段（每段一筆紀錄）。
// 例外：用藥段落裡的「吐了/漏餵」等是用藥狀態，不另起新段。
function splitSegments(tokens) {
  const segments = [];
  let current = [];
  let currentIsMed = false;
  let currentIsFood = false;
  for (const token of tokens) {
    const medStatusInMed = currentIsMed && Boolean(matchWordList(token.toLowerCase(), MED_STATUS_WORDS));
    // 食物段落裡的「水/加水/泡水…」是「泡食物加的水」，不另起新段
    // （交給 parseFoodExtras 抽成 addedWaterMl，合成單筆「食物＋加水」，而非拆成兩筆）
    const waterInFood = currentIsFood && FOOD_WATER_WORDS.has(token);
    if (isSegmentHead(token) && current.length && !medStatusInMed && !waterInFood) {
      segments.push(current);
      current = [token];
      currentIsMed = MED_WORDS.has(token) || Boolean(parseMedToken(token));
      currentIsFood = foodTypeInToken(token);
    } else {
      if (!current.length) {
        currentIsMed = MED_WORDS.has(token) || Boolean(parseMedToken(token));
        currentIsFood = foodTypeInToken(token);
      }
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

// 單段（單筆）解析：token 已去除時間前綴與開頭動詞
function parseSegment(tokens, dayOffset, time) {
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
    // 先抽「另外加水」量，再從剩下的 token 抓食物克數（嚴格：加的水不會被當成克數）
    const { tokens: afterWater, addedWaterMl } = parseFoodExtras(rest);
    const { amount, rest: leftover } = extractAmount(afterWater, 'g');
    if (!amount) {
      // 只有「加水/泡水＋數字」、卻沒有食物克數（罐頭泡水33）→ 語意不明（33 是克數還是加水？）
      // 不預設，回報歧義由呼叫端二選一；一般的缺克數仍回 invalid。
      if (addedWaterMl > 0) return { type: 'foodWaterAmbiguous', foodType: foodEntry.type, amount: addedWaterMl };
      return { type: 'invalid', reason: 'missing_amount', category: 'food' };
    }
    record.category = 'food';
    record.foodType = foodEntry.type;
    record.amount = amount;
    record.unit = 'g';
    record.addedWaterMl = addedWaterMl;
    // 品名 = 剩下的非數字 token；殘留數字原樣保留備註，不臆測
    const nameTokens = [];
    const strayNums = [];
    for (const token of leftover) (parseAmountToken(token) ? strayNums : nameTokens).push(token);
    // 品名去掉殘留的純單位詞（克/公克/g…），避免「乾糧 34 克 加水 14 克」剝完把「克」當品名
    record.itemName = nameTokens.filter((t) => !UNIT_ONLY_WORDS.has(t.toLowerCase())).join(' ');
    if (strayNums.length) record.note = strayNums.join(' ');
    return { type: 'record', record };
  }

  // 藥物：藥 [名稱] [早|中午|晚] [已吃|漏餵|吐掉|拒吃]；或黏字用藥（早藥吃了）＝head 本身帶時段/狀態
  const medFromHead = MED_WORDS.has(head) ? null : parseMedToken(head);
  if (MED_WORDS.has(head) || medFromHead) {
    if (medFromHead) { record.medSlot = medFromHead.medSlot; record.medStatus = medFromHead.medStatus; }
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

  // 營養補充（保健品）：可帶名稱，例如「營養補充 益生菌」；若直接打品名（益生菌）則品名＝該詞
  if (SUPPLEMENT_WORDS.has(head)) {
    record.category = 'supplement';
    record.itemName = SUPPLEMENT_HEAD_WORDS.has(head) ? rest.join(' ') : [head, ...rest].join(' ');
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

  // 疫苗 / 除蟲（照護處置，可帶備註：例如「疫苗 三合一」）
  if (VACCINE_WORDS.has(head)) {
    record.category = 'vaccine';
    record.note = rest.join(' ');
    return { type: 'record', record };
  }
  if (DEWORM_WORDS.has(head)) {
    record.category = 'deworm';
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

  // RC1：類型詞與品名黏著／倒序（罐頭皇家33、皇家罐頭33）→ 解析成食物，品名候選交下游動態比對
  const foodExpr = parseFoodExpression(tokens, dayOffset, time);
  if (foodExpr) return foodExpr;
  // 無類型詞、但有品名＋數量（皇家33）→ 中性候選，交 index.js 反查 food_items，不臆測類型
  const candidate = parseItemLookupCandidate(tokens, dayOffset, time);
  if (candidate) return candidate;

  return { type: 'unknown' };
}

// ── 句首貓名／不明句首偵測（第一階段安全修補用；純函式，不改動 parseMessage）──
// 回傳其一：
//   { kind: 'named', petName, rest }        句首是「同家庭已知貓名」（空格／黏著／標點皆可），rest 為剝掉名字後的事件文字
//   { kind: 'leadingUnknown', prefix, eventText }  句首有不明字、後段可解析（例：旺財喝水1ml）→ 由呼叫端問要記哪隻貓
//   { kind: 'clean' }                        句首就是事件或一般切換／無事件 → 走既有流程
const LEADING_SEP = /^[\s,、。.:：;；~～!！?？@#\-—]+/;

// 所有「事件起始詞」——用來偵測句首雜字後面是否其實有可解析事件
const ALL_HEAD_WORDS = (() => {
  const s = new Set();
  for (const w of WATER_WORDS) s.add(w);
  for (const w of MED_WORDS) s.add(w);
  for (const w of VOMIT_WORDS) s.add(w);
  for (const w of STOOL_PLAIN_WORDS) s.add(w);
  for (const w of STOOL_DETAIL_WORDS) s.add(w);
  for (const w of URINE_WORDS) s.add(w);
  for (const w of SUPPLEMENT_WORDS) s.add(w);
  for (const w of MOOD_WORDS) s.add(w);
  for (const w of MOOD_DETAIL_WORDS) s.add(w);
  for (const w of VACCINE_WORDS) s.add(w);
  for (const w of DEWORM_WORDS) s.add(w);
  for (const w of NOTE_WORDS) s.add(w);
  for (const entry of FOOD_TYPE_WORDS) for (const w of entry.words) s.add(w);
  return [...s];
})();

// 前綴是否「只是時間/動詞雜訊」（吃了、餵了、昨天、21:30…）→ 是的話不算不明句首
function prefixIsOnlyNoise(prefix) {
  let p = String(prefix || '').trim();
  let guard = 0;
  while (p && guard++ < 6) {
    const t = p.match(/^(昨天|前天|今天|\d{1,2}:\d{2})\s*/);
    if (t) { p = p.slice(t[0].length).trim(); continue; }
    let hit = false;
    for (const v of LEAD_VERBS) {
      if (p === v || p.startsWith(v)) { p = p.slice(v.length).trim(); hit = true; break; }
    }
    if (!hit) break;
  }
  return p.length === 0;
}

// 黏著偵測「只」用非食物類的事件詞：因為「罐頭/乾糧/濕食…」常內嵌在食物名字裡
// （希爾斯罐頭、皇家乾糧），拿它們在 token 內比對會誤切食物名。食物名＋份量交第二階段處理。
const FOOD_TYPE_WORD_SET = new Set(FOOD_TYPE_WORDS.flatMap((e) => e.words));
const EMBED_HEAD_WORDS = ALL_HEAD_WORDS.filter((w) => !FOOD_TYPE_WORD_SET.has(w));

// 保守連接詞分隔：把「然後/接著/再」換成空白，但「只有」當它後面緊接一個事件起始詞時才換
// （例：「克然後水 14」→「克 水 14」；「再喝水」→「 喝水」）。避免粗暴全域替換破壞語意。
// 「加」「跟」本輪不納入（會和「加水」等既有語意衝突）。
function splitConnectorsAtEvents(text) {
  let s = String(text || '');
  for (const c of CONNECTOR_WORDS) {
    let idx = 0;
    while ((idx = s.indexOf(c, idx)) !== -1) {
      const after = s.slice(idx + c.length).replace(/^\s+/, '');
      if (after && ALL_HEAD_WORDS.some((w) => after.startsWith(w))) {
        s = `${s.slice(0, idx)} ${s.slice(idx + c.length)}`;
        idx += 1;
      } else {
        idx += c.length;
      }
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

function parsesToRecord(text) {
  const r = parseMessage(text);
  return r.type === 'record' || r.type === 'multiRecord';
}

// 不明句首偵測：前段不明、後段可解析。先試「整個 token 一段段丟」（處理有空格的雜字），
// 再試「第一個 token 內找事件詞」（處理黏著，如 旺財喝水1ml）。回傳 {prefix, eventText} 或 null。
function findLeadingUnknown(norm) {
  const tokens = norm.split(' ');
  // 守門：第一個 token 本身就是事件詞開頭 → 整句是正常（多筆）紀錄，不是不明句首
  // （避免把「喝水1ml」的內部「水」誤當成事件起點、或把「喝水 20 罐頭 5」的句首當雜字）
  const firstTok = tokens[0] || '';
  if (ALL_HEAD_WORDS.some((w) => firstTok.startsWith(w))) return null;
  // 階段一：逐個丟掉開頭整段 token
  for (let k = 1; k < tokens.length; k += 1) {
    const rest = tokens.slice(k).join(' ').replace(LEADING_SEP, '');
    if (!rest) continue;
    if (parsesToRecord(rest)) {
      const prefix = tokens.slice(0, k).join(' ');
      if (prefixIsOnlyNoise(prefix)) return null; // 只是動詞/時間 → 不算不明
      return { prefix: prefix.trim(), eventText: rest };
    }
  }
  // 階段二：黏著情況——在第一個 token 內找最早出現的事件詞（只找非食物類，避免誤切食物名）
  const first = tokens[0] || '';
  let bestIdx = -1;
  for (const w of EMBED_HEAD_WORDS) {
    const i = first.indexOf(w);
    if (i > 0 && (bestIdx === -1 || i < bestIdx)) bestIdx = i;
  }
  if (bestIdx > 0) {
    const prefix = first.slice(0, bestIdx);
    if (prefixIsOnlyNoise(prefix)) return null;
    const rest = (first.slice(bestIdx) + ' ' + tokens.slice(1).join(' ')).trim();
    if (parsesToRecord(rest)) return { prefix: prefix.trim(), eventText: rest };
  }
  return null;
}

export function analyzeLeading(rawText, petNames = []) {
  const norm = normalizeText(rawText);
  if (!norm) return { kind: 'clean' };

  // 1) 句首已知貓名（同家庭；長到短，避免「咪」誤吃「咪咪」；空格／黏著／標點皆可）——最先執行
  const names = [...petNames].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (norm === name) return { kind: 'clean' };            // 只打貓名 → 交回既有「切換預設貓」流程
    if (norm.startsWith(name)) {
      const rest = norm.slice(name.length).replace(LEADING_SEP, '');
      if (!rest) return { kind: 'clean' };
      // 剝出貓名後能可靠解析 → named（可寫入該貓）
      if (parsesToRecord(rest)) return { kind: 'named', petName: name, rest };
      // 剝出貓名、但後段像「食物名＋份量」卻無法可靠解析（如 希爾斯罐頭23g）→ partial：
      // 辨認到貓、但「不寫入、不降級成通用罐頭」；交第二階段用 food_item 精確比對／澄清。
      // 加「像食物/有數量」條件，避免把「蚵仔你好嗎」這種閒聊也當 partial。
      if (/\d/.test(rest) || [...FOOD_TYPE_WORD_SET].some((w) => rest.includes(w))) {
        return { kind: 'partial', petName: name, rest };
      }
      // 其餘（純文字、非食物非數量）→ 交回既有流程當一般 unknown
    }
  }

  // 2) 不明句首 + 後段可解析 → 交由呼叫端問要記哪隻貓（不得靜默寫預設貓）
  const lead = findLeadingUnknown(norm);
  if (lead) return { kind: 'leadingUnknown', prefix: lead.prefix, eventText: lead.eventText };

  return { kind: 'clean' };
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

// 把「罐頭/乾糧/濕食…」這種類別字從品名裡拿掉，只留可辨識的核心字（皇家罐頭 → 皇家）
export function stripFoodTypeWords(value) {
  return String(value || '').toLowerCase().replace(/罐頭|罐罐|乾糧|乾乾|濕糧|濕食|飼料|主食罐|副食罐|罐|包/g, '').replace(/\s+/g, '').trim();
}

// 字元集合 Dice 相似度（0~1）：皇冠 vs 皇家 = 2×1 /(2+2)=0.5；希爾斯 vs 皇冠 = 0
function charDice(a, b) {
  const sa = new Set([...String(a)]);
  const sb = new Set([...String(b)]);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter += 1;
  return (2 * inter) / (sa.size + sb.size);
}

// 模糊比對：打的品名對不到時，猜「最接近的同類型品項」。
// 保守——只用來在確認卡把最可能的排前面/標「最接近」，永遠不會自動記，一定要使用者點選確認。
export function guessFood(foods, itemName, foodType) {
  const target = stripFoodTypeWords(normalizeText(itemName || ''));
  if (!target) return null;
  let best = null;
  let bestScore = 0;
  for (const food of foods || []) {
    if (food.isDeleted) continue;
    if (foodType && food.foodType !== foodType) continue;
    const cand = stripFoodTypeWords(food.displayName) || stripFoodTypeWords(food.brand) || stripFoodTypeWords(food.productName);
    if (!cand) continue;
    const score = charDice(target, cand);
    if (score > bestScore) { best = food; bestScore = score; }
  }
  return bestScore >= 0.4 ? best : null;
}
