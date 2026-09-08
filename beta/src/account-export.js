// Owner-authenticated portability export. Never include login or sharing credentials.
export async function buildAccountExport(db, owner) {
  const queries = [
    ['pets', 'SELECT * FROM pets WHERE ownerLineUserId=? AND isDeleted=0'],
    ...['food_items', 'vets'].map(t => [t, `SELECT * FROM ${t} WHERE ownerLineUserId=? AND isDeleted=0`]),
    ...['logs', 'meds', 'vet_visits', 'labs', 'daily_summary', 'tasks'].map(t => [t,
      `SELECT t.* FROM ${t} t JOIN pets p ON p.petId=t.petId WHERE p.ownerLineUserId=? AND p.isDeleted=0${['logs','meds','vet_visits','labs'].includes(t) ? ' AND t.isDeleted=0' : ''}`])
  ];
  const results = await db.batch(queries.map(([,sql]) => db.prepare(sql).bind(owner)));
  const privateKeys = new Set(['lineUserId','ownerLineUserId','recordedBy','updatedBy','completedBy','sourceMessageId']);
  const data = Object.fromEntries(queries.map(([name], i) => [name, (results[i].results || []).map(row =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !privateKeys.has(key))))]));
  data.careTemplates = [];
  for (const pet of data.pets) {
    const row = await db.prepare('SELECT v FROM app_kv WHERE k=?').bind(`careTemplate:${owner}:${pet.petId}`).first();
    if (row) data.careTemplates.push({ petId:pet.petId, template:JSON.parse(row.v) });
  }
  return { format:'meow-care-export', version:1, exportedAt:new Date().toISOString(),
    description:'全部未刪除貓咪的照護資料；不包含登入憑證、分享連結及系統診斷。JSON 可供程式讀取，並非自動還原檔。',
    counts:Object.fromEntries(Object.entries(data).map(([key,rows]) => [key,rows.length])), data };
}
