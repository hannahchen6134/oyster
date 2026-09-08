import { getUser, resolveDataOwner, listPets } from './db.js';
import { isBetaAllowed } from './plan.js';
import { LINE_EVENT } from './line-event.js';
import { frequentRecordItems } from './frequent-records.js';
import { useShortcutProfile } from './record-shortcut-profile.js';

// Opt in only after an operation finishes; pending questions keep their own controls.
export async function restoreCompletionShortcuts(env, event, user = null, petId = '') {
  const scope = env[LINE_EVENT];
  const actor = event.source?.userId;
  if (!scope || !actor || event.source.type !== 'user') return;
  let owner;
  if (!user) {
    user = await getUser(env.DB, actor, { shortcuts: true });
    if (!isBetaAllowed(user)) return;
    owner = await resolveDataOwner(env.DB, actor);
    useShortcutProfile(env, user, owner);
  }
  if (!isBetaAllowed(user)) return;
  owner ??= await resolveDataOwner(env.DB,actor);
  const pets=await listPets(env.DB,owner);
  const pet=pets.find(p=>p.petId===(petId||user.defaultPetId))||(pets.length===1?pets[0]:null);
  scope.defaultQuickReply = { items: frequentRecordItems(pet?.petId||'',pet?.petName||'') };
}
