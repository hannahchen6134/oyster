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
export function careEditor(draft,esc) {
  const fields=[['feeding','餵食與飲水','品項、份量、時間'],['medicine','用藥安排','若不需餵藥，請寫「不用餵藥」'],['supplies','用品位置','食物、藥與其他用品放在哪裡'],['notes','相處與注意事項','習慣、貓砂、希望留意的事情'],['emergency','聯絡方式','主人聯絡方式，必要時補醫院'],['period','照護期間','選填，例如 9/10 晚上至 9/13 早上']];
  return `<label>有什麼要交代的？<textarea data-report-field="rawNotes" maxlength="6000" placeholder="貼上原本的照護說明，或直接打幾句。只填這隻貓的安排，不用自己分類。">${esc(draft.rawNotes||'')}</textarea></label><p class="purpose-hint">不用準備照片。按「整理說明」時，文字會交由 Cloudflare AI 協助分類；不會補寫份量或時間。</p><div class="report-controls"><button type="button" class="btn btn-primary" id="careOrganize">整理說明</button><button type="button" class="btn btn-secondary" id="careTemplateSave">儲存為範本</button><button type="button" class="btn btn-secondary" id="careTemplateLoad">套用範本</button></div><p id="careToolStatus" role="status"></p><details id="careEditFold"><summary>確認內容／補充資料</summary><p>已帶入這隻貓的設定。請確認時間、份量及用藥是否適用本次照護。</p>${fields.map(([k,l,h])=>`<label>${l}<textarea data-report-field="${k}" maxlength="6000" placeholder="${h}">${esc(draft[k]||'')}</textarea></label>`).join('')}</details>`;
}
