// Shared numeric source for the existing A4 doctor report. Missing days stay null.
const number=v=>Number.isFinite(Number(v))?Number(v):0;
export function cleanDoctorSource(source={}){
 const rows=(Array.isArray(source.rows)?source.rows:[]).slice(0,31).map(r=>({date:String(r.date||'').slice(0,10),...Object.fromEntries(['entryCount','waterMl','foodWaterMl','totalWaterMl','dryFoodG','wetFoodG','otherFoodG','kcal','kcalEstimated'].map(k=>[k,number(r[k])])),kcalIncomplete:!!r.kcalIncomplete}));
 const weights=(Array.isArray(source.weights)?source.weights:[]).slice(0,200).map(w=>({date:String(w.date||'').slice(0,10),amount:number(w.amount)}));
 return {from:String(source.from||'').slice(0,10),to:String(source.to||'').slice(0,10),rows,weights};
}
export function doctorReportData(snapshot){
 const s=cleanDoctorSource(snapshot.doctorSource),rows=s.rows.filter(r=>r.date>=s.from&&r.date<=s.to).sort((a,b)=>a.date.localeCompare(b.date));
 const dates=[];let dt=new Date(s.from+'T00:00:00Z');
 for(let i=0;i<31&&Number.isFinite(+dt);i++,dt.setUTCDate(dt.getUTCDate()+1)){const date=dt.toISOString().slice(0,10);if(date>s.to)break;dates.push(date);}
 const byDate=new Map(rows.map(r=>[r.date,r]));
 const weights=new Map(s.weights.filter(w=>w.amount>0).map(w=>[w.date,w.amount]));
 const delta=(values,sparse)=>{const ns=values.filter(v=>v!=null);if(ns.length<2)return null;const a=sparse?[ns.at(-2)]:ns.slice(-14,-7),b=sparse?[ns.at(-1)]:ns.slice(-7);if(!a.length)return null;const avg=v=>v.reduce((x,y)=>x+y,0)/v.length;return avg(a)>0?Math.round((avg(b)-avg(a))/avg(a)*100):null;};
 const metric=(field)=>{const values=dates.map(date=>field==='weight'?(weights.get(date)??null):byDate.get(date)?.entryCount?number(byDate.get(date)[field]):null);return {latest:values.filter(v=>v!=null).at(-1)??null,points:dates.map((date,i)=>({date,value:values[i]})),deltaPct:delta(values,field==='weight'),count:values.filter(v=>v!=null).length};};
 const sum=key=>rows.reduce((v,r)=>v+number(r[key]),0),own=sum('waterMl'),food=sum('foodWaterMl'),dry=sum('dryFoodG'),wet=sum('wetFoodG')+food,other=sum('otherFoodG');
 return {petName:snapshot.petName,reportName:'回診摘要',source:'喵喵管家',dateRangeLabel:snapshot.dateRangeLabel,rangeDays:snapshot.rangeDays,generatedAt:snapshot.generatedAt,
 weight:metric('weight'),water:metric('totalWaterMl'),kcal:{...metric('kcal'),estimated:rows.some(r=>r.kcalEstimated),incomplete:rows.some(r=>r.kcalIncomplete)},
 composition:{hasData:own+food+dry+wet+other>0,water:{total:own+food,own,food},food:{total:dry+wet+other,dry,wet,other}},
 digest:(snapshot.sections||[]).filter(s=>!/體重紀錄|飲食與飲水紀錄變化|每日紀錄/.test(s.title)).flatMap(s=>s.items.map(text=>({date:'',typeLabel:s.title,text}))),
 daily:rows.filter(r=>r.entryCount>0).reverse().map(r=>({date:r.date,waterMl:r.totalWaterMl,wetG:r.wetFoodG+r.foodWaterMl,dryG:r.dryFoodG,kcal:r.kcal,kcalEstimated:!!r.kcalEstimated,kcalIncomplete:r.kcalIncomplete}))};
}
