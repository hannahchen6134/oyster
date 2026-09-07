// Stable category shortcuts. A tap never assumes an amount or records a dose.
export const FREQUENT_RECORDS = [
  ['主食','wet'],['乾乾','dry'],['零食','snack'],['水','water'],['藥','med'],['尿尿','urine'],['便便','stool'],['更多紀錄','more']
];
export const ALL_RECORDS = [...FREQUENT_RECORDS.filter(([,kind])=>kind!=='more'),
  ['體重','weight'],['嘔吐','vomit'],['精神','mood'],['保健','supplement'],['備註','note']];
export function frequentRecordItems(petId='',petName='',entries=FREQUENT_RECORDS) {
  return entries.map(([label,kind])=>{
    if(kind==='more')return {type:'action',action:{type:'postback',label:'更多紀錄',data:'action=recmore',displayText:'更多紀錄'}};
    const fill=!['urine','stool'].includes(kind);
    return {type:'action',action:{
      type:'postback',label,data:`action=frequent&kind=${kind}${petId&&(!fill||petName)?'&petId='+encodeURIComponent(petId):''}${fill?'&input=fill':''}`,
      ...(fill?{inputOption:'openKeyboard',fillInText:petName?`${petName} ${label}`:label}:{displayText:label})
    }};
  });
}
// Reuse the same action factory in a persistent card grid and the transient quick
// reply strip. The grid remains tappable when LINE hides the strip after a tap.
export function withFrequentRecords(message,petId='',{persistent=true,petName=''}={}) {
  const items=frequentRecordItems(petId);
  const result={...message,quickReply:{items}};
  if(persistent&&message.type==='flex'&&message.contents?.type==='bubble'&&message.contents.body?.layout==='vertical') {
    // Old cards can be tapped after switching pets. Name the card's cat in filled
    // text so reusing that card cannot silently write to the new default cat.
    const cardItems=frequentRecordItems(petId,petName);
    const rows=recordGridRows(cardItems);
    const grid={type:'box',layout:'vertical',spacing:'sm',margin:'lg',contents:[
      {type:'box',layout:'vertical',spacing:'xs',contents:[
        {type:'text',text:petName?`再幫${petName}記一筆`:'再記一筆',size:'sm',weight:'bold',color:'#5C4A38',wrap:true},
        {type:'text',text:'點類別，再填數量或情況',size:'xs',color:'#5C4A38',wrap:true}
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
const common = action => action?.type==='postback'&&new URLSearchParams(action.data).get('action')==='frequent';
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
    const petName=fill?.action.fillInText.slice(0,-fill.action.label.length).trim()||'';
    result={...result,quickReply:{items:[...frequentRecordItems(petId,petName,entries),...items.filter(i=>!common(i.action)&&!more(i.action))].slice(0,13)}};
  }
  const body=message.contents?.body;
  if(body?.contents){
    const contents=body.contents.map(grid=>{
      const cells=grid.contents?.slice(1).flatMap(row=>row.contents||[]).filter(cell=>cell.action);
      if(!cells||cells.length!==8||!cells.every(cell=>common(cell.action)||more(cell.action)))return grid;
      const fill=cells.find(cell=>cell.action.fillInText)?.action;
      const petName=fill?.fillInText.slice(0,-fill.label.length).trim()||'';
      const petId=new URLSearchParams(cells[0].action.data).get('petId')||'';
      return {...grid,contents:[grid.contents[0],...recordGridRows(frequentRecordItems(petId,petName,entries))]};
    });
    result={...result,contents:{...message.contents,body:{...body,contents}}};
  }
  return result;
}
