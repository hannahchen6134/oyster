import qrcode from './qrcode.mjs';
export async function qrPng(url, label) {
  const qr=qrcode(0,'M');qr.addData(url,'Byte');qr.make();
  const svg=qr.createSvgTag({cellSize:8,margin:32,scalable:true});
  const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  await image.decode();const canvas=document.createElement('canvas');canvas.width=800;canvas.height=940;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fffdf8';ctx.fillRect(0,0,800,940);ctx.fillStyle='#583c20';ctx.textAlign='center';ctx.font='bold 28px sans-serif';
  // 長名字保留完整，以分行呈現，不縮字也不裁掉。
  const lines=[];let line='';for(const c of label){if(ctx.measureText(line+c).width>704){lines.push(line);line='';}line+=c;}lines.push(line);
  const extra=Math.max(0,lines.length-1)*36;canvas.height=940+extra;ctx.fillStyle='#fffdf8';ctx.fillRect(0,0,800,canvas.height);ctx.fillStyle='#583c20';ctx.textAlign='center';ctx.font='bold 28px sans-serif';lines.forEach((s,i)=>ctx.fillText(s,400,64+i*36));
  ctx.drawImage(image,48,100+extra,704,704);ctx.font='24px sans-serif';ctx.fillText('掃碼查看這份報告',400,850+extra);ctx.font='20px sans-serif';ctx.fillText('喵喵管家 · 有效期限以報告頁為準',400,898+extra);
  return canvas.toDataURL('image/png');
}
export function carePrefill(draft,esc) {
  const values=[['medicine','用藥安排'],['notes','注意事項'],['emergency','醫院與聯絡'],['feeding','餵食安排'],['supplies','用品位置']].filter(([key])=>String(draft[key]||'').trim());
  return `<div class="care-prefill-head"><h2>已幫你帶入</h2><span>${values.length} 項資料</span></div>${values.length?`<dl>${values.map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(draft[key])}</dd></div>`).join('')}</dl>`:'<p class="muted">目前還沒有照護設定，可以在下方補充一次，之後存成範本沿用。</p>'}<button id="careEditOpen" class="link-btn back-link" type="button">查看／修改內容 →</button>`;
}
export function careEditor(draft,esc) {
  const fields=[['feeding','餵食與飲水','品項、份量、時間'],['medicine','用藥安排','若不需餵藥，請寫「不用餵藥」'],['supplies','用品位置','食物、藥與其他用品放在哪裡'],['notes','相處與注意事項','習慣、貓砂、希望留意的事情'],['emergency','聯絡方式','爸媽聯絡方式，必要時補醫院'],['period','照護期間','選填，例如 9/10 晚上至 9/13 早上']];
  return `<section id="carePrefillSummary" class="care-prefill">${carePrefill(draft,esc)}</section><p class="purpose-hint care-source">用藥、注意事項及指定醫院來自現有設定；請確認這次是否適用。</p><div id="careRecentReference"></div><label class="care-note-label">這次還有什麼要補充？<span class="purpose-hint">已有的資料不用重填，只寫這次不同的安排。</span><textarea data-report-field="rawNotes" maxlength="6000" placeholder="例如：這次晚上改由保母餵食，飼料放在廚房右邊抽屜。">${esc(draft.rawNotes||'')}</textarea></label><div class="report-controls care-edit-actions"><button type="button" class="btn btn-primary" id="careOrganize">整理補充</button><button type="button" class="btn btn-secondary" id="careTemplateSave">存為範本</button><button type="button" class="btn btn-secondary" id="careTemplateLoad">套用範本</button></div><p class="purpose-hint">整理時由 Cloudflare AI 分類你填的文字，不補寫份量或時間。</p><p id="careToolStatus" role="status"></p><details id="careEditFold" class="accordion"><summary>確認內容／補充資料<span aria-hidden="true">⌄</span></summary><p class="purpose-hint">請確認時間、份量與用藥。</p>${fields.map(([k,l,h])=>`<label>${l}<textarea data-report-field="${k}" maxlength="6000" placeholder="${h}">${esc(draft[k]||'')}</textarea></label>`).join('')}</details>`;
}
