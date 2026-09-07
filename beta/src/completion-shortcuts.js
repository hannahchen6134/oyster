import { getUser, resolveDataOwner } from './db.js';
import { isBetaAllowed } from './plan.js';
import { LINE_EVENT } from './line-event.js';
import { frequentRecordItems } from './frequent-records.js';
import { useShortcutProfile } from './record-shortcut-profile.js';

// Opt in only after an operation finishes; pending questions keep their own controls.
export async function restoreCompletionShortcuts(env, event, user = null, petId = '') {
  const scope = env[LINE_EVENT];
  const actor = event.source?.userId;
  if (!scope || !actor || event.source.type !== 'user') return;
  if (!user) {
    user = await getUser(env.DB, actor, { shortcuts: true });
    if (!isBetaAllowed(user)) return;
    const owner = await resolveDataOwner(env.DB, actor);
    useShortcutProfile(env, user, owner);
  }
  if (!isBetaAllowed(user)) return;
  scope.defaultQuickReply = { items: frequentRecordItems(petId) };
}
