// Six stable category shortcuts. A tap never assumes an amount or records a dose.
export const FREQUENT_RECORDS = [
  ['主食','wet'],['乾乾','dry'],['水','water'],['藥','med'],['尿尿','urine'],['便便','stool']
];
export function frequentRecordItems(petId='') {
  return FREQUENT_RECORDS.map(([label,kind])=>({type:'action',action:{
    type:'postback',label,data:`action=frequent&kind=${kind}${petId?'&petId='+encodeURIComponent(petId):''}`,
    displayText:label,...(['wet','dry','water'].includes(kind)?{inputOption:'openKeyboard'}:{})
  }}));
}
export function withFrequentRecords(message,petId='') {
  return {...message,quickReply:{items:frequentRecordItems(petId)}};
}
