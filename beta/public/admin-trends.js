(()=>{
 const dataNode=document.getElementById('trendData');if(!dataNode)return;
 const data=JSON.parse(dataNode.textContent),root=document.getElementById('trendCharts'),period=document.getElementById('trendPeriod');
 const days=new Map(data.days.map(d=>[d.day,d])),first=new Map(data.first.map(d=>[d.day,d.newcomers]));
 const dateAt=(offset)=>new Date(Date.parse(data.today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 const value=(date,key)=>!data.start||date<data.start?null:key==='newcomers'?(first.get(date)||0):(days.get(date)?.[key]||0);
 const configs=[['active','每天有記錄的客戶','人','每個帳戶每天只計一次'],['records','每天成功記錄筆數','筆','依實際新增時間，含後來刪除的紀錄'],['newcomers','每天首次開始記錄的人數','人','以帳戶第一筆可用紀錄計算']];
 const svgNS='http://www.w3.org/2000/svg';
 function svgEl(name,attrs){const e=document.createElementNS(svgNS,name);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;}
 function draw(){root.replaceChildren();const n=Number(period.value);
 configs.forEach(([key,title,unit,description])=>{
 const series=Array.from({length:n},(_,i)=>({date:dateAt(i-n+1),value:value(dateAt(i-n+1),key)}));
 const card=document.createElement('article');card.className='trend-card';
 const h=document.createElement('h3');h.textContent=title;card.append(h);
 const desc=document.createElement('p');desc.className='muted';desc.textContent=description;card.append(desc);
 const summary=document.createElement('p');summary.className='trend-summary';
 const complete=Array.from({length:n},(_,i)=>value(dateAt(i-n),key)),previous=Array.from({length:n},(_,i)=>value(dateAt(i-2*n),key));
 if(complete.every(v=>v!==null)){const mean=complete.reduce((a,b)=>a+b,0)/n;summary.textContent='前 '+n+' 個完整日期日均 '+mean.toFixed(1)+' '+unit;
 if(previous.every(v=>v!==null)){const diff=mean-previous.reduce((a,b)=>a+b,0)/n;summary.textContent+=' · 較前期'+(diff>0?'增加 ':diff<0?'減少 ':'持平')+(diff!==0?Math.abs(diff).toFixed(1)+' '+unit:'');}
 else summary.textContent+=' · 前期資料不足';
 }else summary.textContent='完整日期不足，暫不比較平均';card.append(summary);
 const max=Math.max(1,...series.map(d=>d.value||0));const W=520,H=200,L=38,R=12,T=18,B=28;
 const x=i=>L+i*(W-L-R)/(n-1),y=v=>H-B-v/max*(H-T-B);
 const svg=svgEl('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':title+'，使用下方日期控制查看每日數值'});svg.classList.add('trend-svg');
 for(const v of [0,max]){svg.append(svgEl('line',{x1:L,y1:y(v),x2:W-R,y2:y(v),stroke:'#ded7cb'}));const text=svgEl('text',{x:L-6,y:y(v)+4,'text-anchor':'end',fill:'#716b60','font-size':14});text.textContent=v;svg.append(text);}
 let path='',started=false;series.forEach((d,i)=>{if(d.value===null){started=false;return;}path+=(started?'L':'M')+x(i)+' '+y(d.value)+' ';started=true;});
 svg.append(svgEl('path',{d:path,fill:'none',stroke:'#734921','stroke-width':2.5,'stroke-linejoin':'round'}));
 for(const i of [0,n-1]){const text=svgEl('text',{x:x(i),y:H-5,'text-anchor':i?'end':'start',fill:'#716b60','font-size':14});text.textContent=series[i].date.slice(5).replace('-','/');svg.append(text);}
 const dot=svgEl('circle',{r:4,fill:'#734921'});svg.append(dot);card.append(svg);
 const label=document.createElement('label');label.className='trend-date-label';label.textContent='選擇日期';
 const range=document.createElement('input');range.type='range';range.min=0;range.max=n-1;range.value=n-1;range.setAttribute('aria-label',title+'：選擇日期');label.append(range);card.append(label);
 const output=document.createElement('output');output.className='trend-value';output.setAttribute('aria-live','polite');card.append(output);
 function select(i){range.value=i;const d=series[i];output.textContent=d.date+'：'+(d.value===null?'沒有可用資料':d.value+' '+unit)+(d.date===data.today?'（今天累計中）':'');range.setAttribute('aria-valuetext',output.textContent);dot.setAttribute('cx',x(i));dot.setAttribute('cy',y(d.value||0));dot.style.display=d.value===null?'none':'';}
 range.addEventListener('input',()=>select(Number(range.value)));svg.addEventListener('click',e=>{const rect=svg.getBoundingClientRect();select(Math.max(0,Math.min(n-1,Math.round(((e.clientX-rect.left)/rect.width*W-L)/(W-L-R)*(n-1)))));});select(n-1);
 const detail=document.createElement('details');detail.className='method-note';const caption=document.createElement('summary');caption.textContent='查看每日數字';detail.append(caption);const list=document.createElement('ul');list.className='trend-table';series.slice().reverse().forEach(d=>{const li=document.createElement('li');li.textContent=d.date+'　'+(d.value===null?'沒有可用資料':d.value+' '+unit);list.append(li);});detail.append(list);card.append(detail);root.append(card);
 });}
 period.addEventListener('change',draw);draw();
})();
