// Stable category shortcuts. A tap never assumes an amount or records a dose.
export const FREQUENT_RECORDS = [
  ['主食','wet'],['乾乾','dry'],['零食','snack'],['水','water'],['藥','med'],['尿尿','urine'],['便便','stool'],['更多紀錄','more']
];
export const ALL_RECORDS = [...FREQUENT_RECORDS.filter(([,kind])=>kind!=='more'),
  ['體重','weight'],['嘔吐','vomit'],['精神','mood'],['保健','supplement'],['備註','note']];
export const COMBO_RECORDS = [['主食＋水','wetWater'],['副食＋水','sideWater']];
export function shortcutEntries(entries) {
  if(!entries.some(([,k])=>k==='more'))return entries;
  let out=entries.filter(([,k])=>k!=='more');
  if(!out.some(([,k])=>k==='wetWater'))out.splice(JSON.stringify(entries)===JSON.stringify(FREQUENT_RECORDS)?1:out.length,0,COMBO_RECORDS[0]);
  if(!out.some(([,k])=>k==='sideWater'))out.push(COMBO_RECORDS[1]);
  return [...out,['更多紀錄','more']];
}
export function frequentRecordItems(petId='',petName='',entries=FREQUENT_RECORDS) {
  return shortcutEntries(entries).map(([label,kind])=>{
    if(kind==='more')return {type:'action',action:{type:'postback',label:'更多紀錄',data:'action=recmore',displayText:'更多紀錄'}};
    const combo=['wetWater','sideWater'].includes(kind);
    const input=combo?(kind==='wetWater'?'主食\n水':'副食\n水'):label;
    const fill=!['urine','stool'].includes(kind);
    return {type:'action',action:{
      type:'postback',label,data:`action=frequent&kind=${combo?'wet':kind}${combo?'&combo='+kind:''}${petId&&(!fill||petName)?'&petId='+encodeURIComponent(petId):''}${fill?'&input=fill':''}`,
      ...(fill?{inputOption:'openKeyboard',fillInText:petName?`${petName} ${input}`:input}:{displayText:label})
    }};
  });
}
// Reuse the same action factory in a persistent card grid and the transient quick
// reply strip. The grid remains tappable when LINE hides the strip after a tap.
export function withFrequentRecords(message,petId='',{persistent=true,petName=''}={}) {
  const items=frequentRecordItems(petId,petName);
  const result={...message,quickReply:{items}};
  if(persistent&&message.type==='flex'&&message.contents?.type==='bubble'&&/^已(?:記錄|更新)/.test(message.altText||'')&&message.contents.footer){
    const original=message.contents.footer;
    const buttons=original.contents||[];
    const site=buttons.find(b=>b.action?.label==='開啟管家後台');
    const edits=buttons.filter(b=>/action=(?:editAmount|undoOp|delAsk)&/.test(b.action?.data||''));
    const other=buttons.filter(b=>b!==site&&!edits.includes(b));
    const link=(action,label)=>({type:'box',layout:'vertical',flex:1,paddingTop:'12px',paddingBottom:'12px',paddingStart:'4px',paddingEnd:'4px',action,
      contents:[{type:'text',text:label,size:'sm',color:'#734921',align:'center',wrap:true}]});
    const row=contents=>({type:'box',layout:'horizontal',spacing:'sm',contents});
    const footer={...original,contents:[
      ...(edits.length?[row(edits.map(b=>link(b.action,b.action.label.replace(/^[^\u4e00-\u9fff]+/,''))))]:[]),
      ...other,
      row([link({type:'message',label:'常用快捷',text:'記一筆'},'常用快捷 ›'),...(site?[link(site.action,'管家後台 ›')]:[])])
    ]};
    return {...result,contents:{...message.contents,footer}};
  }

  if(persistent&&message.type==='flex'&&message.contents?.type==='bubble'&&message.contents.body?.layout==='vertical') {
    // Old cards can be tapped after switching pets. Name the card's cat in filled
    // text so reusing that card cannot silently write to the new default cat.
    const cardItems=frequentRecordItems(petId,petName);
    const rows=recordGridRows(cardItems);
    const grid={type:'box',layout:'vertical',spacing:'sm',margin:'lg',contents:[
      {type:'box',layout:'vertical',spacing:'xs',contents:[
        {type:'text',text:petName?`再幫${petName}記一筆`:'再記一筆',size:'sm',weight:'bold',color:'#5C4A38',wrap:true},
        {type:'text',text:'點快捷，在文字後補數量，再送出。',size:'xs',color:'#5C4A38',wrap:true}
      ]},...rows
    ]};
    result.contents={...message.contents,body:{...message.contents.body,contents:[...message.contents.body.contents,grid]}};
  }
  return result;
}
function recordGridRows(items) {
  return Array.from({length:Math.ceil(items.length/3)},(_,index)=>{
    const contents=items.slice(index*3,index*3+3).map(({action})=>({
      type:'box',layout:'vertical',flex:1,paddingTop:'14px',paddingBottom:'14px',paddingStart:'8px',paddingEnd:'8px',cornerRadius:'8px',
      backgroundColor:'#F4EDE0',borderColor:'#EDE4D6',borderWidth:'1px',justifyContent:'center',action,
      contents:[{type:'text',text:action.label,size:'sm',weight:'bold',color:'#734921',align:'center',wrap:true}]
    }));
    while(contents.length<3)contents.push({type:'box',layout:'vertical',flex:1,contents:[]});
    return {type:'box',layout:'horizontal',spacing:'sm',contents};
  });
}
const common = action => action?.type==='postback'&&new URLSearchParams(action.data).get('action')==='frequent'&&!new URLSearchParams(action.data).has('combo');
const combo = action => action?.type==='postback'&&new URLSearchParams(action.data).get('action')==='frequent'&&new URLSearchParams(action.data).has('combo');
const more = action => action?.type==='postback'&&new URLSearchParams(action.data).get('action')==='recmore';
const completeStrip = items => items?.length>=7&&['wet','dry','snack','water','med','urine','stool'].every(kind=>items.some(i=>common(i.action)&&new URLSearchParams(i.action.data).get('kind')===kind));
// Only replace the standard category group. Cat choices, confirmation controls,
// and the complete "more" menu retain their exact actions and ordering.
export function personalizeFrequentMessage(message,entries) {
  if(!entries)return message;
  let result=message;
  const items=message.quickReply?.items;
  if(completeStrip(items)&&items.filter(i=>common(i.action)).length===7){
    const old=items.find(i=>common(i.action)&&new URLSearchParams(i.action.data).has('petId'));
    const petId=old?new URLSearchParams(old.action.data).get('petId'):'';
    const fill=items.find(i=>common(i.action)&&i.action.fillInText);
    const petName=fill?.action.fillInText.trimEnd().slice(0,-fill.action.label.length).trim()||'';
    const first=items.findIndex(i=>common(i.action)||combo(i.action)||more(i.action));
    const extra=i=>!common(i.action)&&!combo(i.action)&&!more(i.action);
    result={...result,quickReply:{items:[...items.slice(0,first).filter(extra),...frequentRecordItems(petId,petName,entries),...items.slice(first).filter(extra)].slice(0,13)}};
  }
  const body=message.contents?.body;
  if(body?.contents){
    const contents=body.contents.map(grid=>{
      const cells=grid.contents?.slice(1).flatMap(row=>row.contents||[]).filter(cell=>cell.action);
      if(!cells||cells.filter(cell=>common(cell.action)).length!==7||!cells.every(cell=>common(cell.action)||combo(cell.action)||more(cell.action)))return grid;
      const fill=cells.find(cell=>common(cell.action)&&cell.action.fillInText)?.action;
      const petName=fill?.fillInText.trimEnd().slice(0,-fill.label.length).trim()||'';
      const petId=new URLSearchParams(cells[0].action.data).get('petId')||'';
      return {...grid,contents:[grid.contents[0],...recordGridRows(frequentRecordItems(petId,petName,entries))]};
    });
    result={...result,contents:{...message.contents,body:{...body,contents}}};
  }
  return result;
}
