// Stable category shortcuts. A tap never assumes an amount or records a dose.
export const FREQUENT_RECORDS = [
  ['主食','wet'],['乾乾','dry'],['乾糧','dry'],['零食','snack'],['水','water'],['藥','med'],['尿尿','urine'],['便便','stool']
];
export function frequentRecordItems(petId='',petName='') {
  return FREQUENT_RECORDS.map(([label,kind])=>{
    const fill=['wet','dry','snack','water','med'].includes(kind);
    return {type:'action',action:{
      type:'postback',label,data:`action=frequent&kind=${kind}${petId&&(!fill||petName)?'&petId='+encodeURIComponent(petId):''}${fill?'&input=fill':''}`,
      ...(fill?{inputOption:'openKeyboard',fillInText:petName?`${petName} ${label}`:label}:{displayText:label})
    }};
  });
}
export function withFrequentRecords(message,petId='') {
  return {...message,quickReply:{items:frequentRecordItems(petId)}};
}
