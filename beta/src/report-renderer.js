import puppeteer from '@cloudflare/puppeteer';
import qrcode from '../public/qrcode.mjs';
import { escapeReport as esc } from '../public/report-purpose.js';
import { buildA4Report } from '../public/a4-report.js';
import { doctorReportData } from '../public/doctor-report-data.js';
import { reportA4Css } from '../public/report-a4-style.js';

// No external assets or user URLs are fetched: only escaped snapshot text and our QR SVG.
export function imageDocument(snapshot, url) {
  const html=baseImageDocument(snapshot,url);
  if(snapshot.purpose!=='doctor'||!snapshot.doctorSource)return html;
  const built=buildA4Report(doctorReportData(snapshot));
  return html.replace('</style>',`${reportA4Css}\n.a4-page{width:760px;min-height:0;overflow:visible;font:14px/1.4 sans-serif;--serif:serif}.a4-page section{padding:9px 11px 10px}.a4-page h2{font-size:17px}.a4-page p{white-space:normal}</style>`).replace('<div id="pages">',built.html.replaceAll('class="a4-page"','class="a4-page page"')+'<div id="pages">');
}
function baseImageDocument(snapshot, url) {
  const qr=qrcode(0,'M'); qr.addData(url,'Byte'); qr.make();
  const blocks=snapshot.sections.flatMap(section => section.items.flatMap((item,index) => {
    const chunks=Array.from(String(item)).reduce((a,c,i)=>{if(i%220===0)a.push('');a[a.length-1]+=c;return a;},[]);
    return chunks.map((chunk,n)=>`<section>${index===0&&n===0?`<h2>${esc(section.title)}</h2>`:''}<p>${esc(chunk)}</p></section>`);
  })).join('');
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  *{box-sizing:border-box}body{margin:0;background:#efe8dc;color:#403526;font:22px/1.65 "Noto Sans CJK TC","Noto Sans CJK JP",sans-serif}
  .page{width:760px;background:#fffdf8;padding:40px 44px;border-top:8px solid #734921;overflow-wrap:anywhere;margin:0 0 20px}
  header{border-bottom:1px solid #d9cbb8;margin-bottom:18px;padding-bottom:16px}header small,footer{font-size:17px;color:#776a59}h1{font-size:34px;margin:4px 0}h2{font-size:24px;color:#734921;margin:0 0 8px}p{white-space:pre-wrap;margin:0}section{padding:14px 0;border-bottom:1px solid #e7dfd3}.notice{font-size:18px;background:#f4eee3;padding:14px;margin:14px 0}footer{padding-top:20px}.qr{text-align:center}.qr svg{display:block;width:560px;height:560px;margin:24px auto}#source{display:none}
  </style><template id="heading"><header><small>喵喵管家 · ${esc(snapshot.petName)}</small><h1>${esc(snapshot.reportName)}</h1><p>${esc(snapshot.dateRangeLabel)}</p></header></template><div id="source"><section class="notice">${esc(snapshot.notice)}</section>${snapshot.empty?'<section>此期間沒有足夠紀錄；沒有紀錄不代表沒有發生。</section>':''}${blocks}</div><div id="pages"></div><article class="page qr" id="qr"><header><small>喵喵管家 · ${esc(snapshot.petName)}</small><h1>${esc(snapshot.reportName)}</h1></header>${qr.createSvgTag({cellSize:8,margin:32,scalable:true})}<h2>掃碼查看這份報告</h2><p>與報告圖片為同一份內容</p><footer>連結有效 7 天；可由爸媽提前停用。</footer></article></html>`;
}

// Kept separate so the exact pagination can also be verified in a local browser.
export function paginateImages() {
  const host=document.querySelector('#pages'), source=document.querySelector('#source');
  let page;
  const next=()=>{page=document.createElement('article');page.className='page report';page.innerHTML=document.querySelector('#heading').innerHTML;host.append(page);};
  next();
  for(const block of [...source.children]) {
    page.append(block);
    if(page.getBoundingClientRect().height>1080&&page.children.length>2){block.remove();next();page.append(block);}
  }
  const pages=[...host.children];
  pages.forEach((p,i)=>{const f=document.createElement('footer');f.textContent=`${i+1} / ${pages.length} · 讓每一次紀錄，都是對貓貓的守護`;p.append(f);});
  return pages.length;
}

export async function renderReportImages(env,snapshot,url) {
  const controller=new AbortController();let timer;
  try{return await Promise.race([
    renderImages(env,snapshot,url,controller.signal),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('report render timeout'));},20000);})
  ]);}finally{clearTimeout(timer);}
}
async function renderImages(env,snapshot,url,signal) {
  if(!env.REPORT_BROWSER)throw Error('REPORT_BROWSER unavailable');
  const browser=await puppeteer.launch(env.REPORT_BROWSER);
  if(signal.aborted){void browser.close().catch(()=>{});throw Error('report render timeout');}
  const abort=()=>{void browser.close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try {
    const page=await browser.newPage();
    await page.setViewport({width:760,height:1200,deviceScaleFactor:1});
    await page.setContent(imageDocument(snapshot,url).replace("default-src 'none';", "default-src 'none'; img-src data:;"),{waitUntil:'domcontentloaded',timeout:10000});
    await page.evaluate(()=>document.fonts.ready);
    await page.evaluate(paginateImages);
    const count=await page.$$eval('.page',pages=>pages.length-1);
    if(count>30)throw Error('report too long');
    // One remote screenshot, then crop inside the browser: avoid one slow CDP
    // screenshot round trip for every report page.
    const full=await page.screenshot({type:'png',encoding:'base64',fullPage:true});
    const images=await page.evaluate(cropReportPages,full);
    if(images.some(png=>png.length>1_300_000))throw Error('report image too large');
    return images;
  } finally {signal.removeEventListener('abort',abort);await browser.close();}
}

export async function cropReportPages(png){
  const img=new Image();img.src='data:image/png;base64,'+png;await img.decode();
  return [...document.querySelectorAll('.page')].map(element=>{
    const r=element.getBoundingClientRect(),canvas=document.createElement('canvas');
    canvas.width=Math.ceil(r.width);canvas.height=Math.ceil(r.height);
    canvas.getContext('2d').drawImage(img,r.x+scrollX,r.y+scrollY,r.width,r.height,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  });
}
