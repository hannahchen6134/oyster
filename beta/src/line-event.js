// One event owns its timings and deferred work; never share user state across requests.
export const LINE_EVENT = Symbol('lineEvent');
const RAW_STATEMENT = Symbol('rawStatement');
const round = n => Math.round(Math.max(0, n) * 10) / 10;
const tables = new Set(['users','pets','food_items','logs','daily_summary','app_kv','sessions','care_members','events','text_inputs','tasks']);

export function markEvent(env, name) { env[LINE_EVENT]?.mark(name); }
export async function measureEvent(env, name, work) {
  const scope = env[LINE_EVENT];
  if (!scope) return work();
  const start = performance.now();
  try { return await work(); }
  finally { scope.addSpan(name, performance.now() - start); }
}

export async function afterEventReply(env, key, work) {
  const scope = env[LINE_EVENT];
  if (scope) { if (!scope.effects.has(key)) scope.effects.set(key, work); return; }
  // Non-webhook callers retain awaited ownership of their work.
  try { return await work(); }
  catch { console.warn('line_background_failed', { task: key.split(':')[0] }); }
}

function instrumentDb(db, scope) {
  const wrap = (statement, label) => new Proxy(statement, {
    get(target, key) {
      if (key === RAW_STATEMENT) return { statement: target, label };
      if (key === 'bind') return (...args) => wrap(target.bind(...args), label);
      if (['first','all','run','raw'].includes(key)) return (...args) => scope.sql(label, () => target[key](...args));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return sql => {
        const op = String(sql).trim().split(/\s+/)[0].toLowerCase();
        const table = String(sql).match(/(?:FROM|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+([a-z_]+)/i)?.[1]?.toLowerCase();
        const label = `${['select','insert','update','delete','create','alter'].includes(op) ? op : 'other'}:${tables.has(table) ? table : 'other'}`;
        return wrap(target.prepare(sql), label);
      };
      if (key === 'batch') return statements => {
        const raw = statements.map(s => s[RAW_STATEMENT] || { statement: s, label: 'other:batch' });
        return scope.sql('batch', () => target.batch(raw.map(s => s.statement)), raw.length);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export async function withLineEvent(env, event, work, request = {}) {
  if (env[LINE_EVENT]) return work(env);
  const start = request.receivedAt ?? performance.now();
  const trace = crypto.randomUUID();
  const scope = {
    actor: event.source?.userId,
    effects: new Map(), marks: {}, spans: {}, queries: {}, line: [],
    recordCount: 0, categories: new Set(), intent: '', phase: 'before_reply',
    firstReplyMs: null, acceptedReplyMs: null, status: 'handled',
    mark(name) { this.marks[name] = round(performance.now() - start); },
    addSpan(name, ms) { this.spans[name] = round((this.spans[name] || 0) + ms); },
    async sql(label, work, count = 1) {
      const phase = this.phase, t = performance.now();
      const key = `${phase}:${label}`;
      const metric = this.queries[key] ||= { count: 0, ms: 0, errors: 0, rows_read: 0, rows_written: 0, sql_ms: 0 };
      metric.count += count;
      try {
        const result = await work();
        for (const r of (Array.isArray(result) ? result : [result])) {
          const meta = r?.meta;
          if (!meta) continue;
          metric.rows_read += Number(meta.rows_read) || 0;
          metric.rows_written += Number(meta.rows_written) || 0;
          metric.sql_ms = round(metric.sql_ms + (Number(meta.timings?.sql_duration_ms) || 0));
          if (meta.served_by_region) this.dbRegion = meta.served_by_region;
          if (meta.served_by_colo) this.dbColo = meta.served_by_colo;
        }
        return result;
      } catch (error) { metric.errors++; throw error; }
      finally { metric.ms = round(metric.ms + performance.now() - t); }
    },
    beforeDelivery() {
      this.deliveryStarted = true;
      this.stopLoading?.();
      this.firstReplyMs ??= round(performance.now() - start);
      this.mark('before_line');
    }
  };
  const scoped = { ...env, DB: instrumentDb(env.DB, scope), [LINE_EVENT]: scope };
  const emit = type => {
    if (scope.recordCount || ['record','multiRecord','foodAdjust','weightModify','item_lookup_candidate','ambiguousAmounts','partial','invalid','unknown'].includes(scope.intent)) console.log(JSON.stringify({
      type, version: 1, trace,
      status: scope.status, intent: scope.intent, records: scope.recordCount,
      categories: [...scope.categories], caregiver: scope.caregiver || false,
      colo: request.colo || null, placement: request.placement || null,
      db_region: scope.dbRegion || null, db_colo: scope.dbColo || null,
      server_ms: scope.firstReplyMs, line_accepted_ms: scope.acceptedReplyMs,
      marks: scope.marks, spans: scope.spans, queries: scope.queries, line: scope.line
    }));
  };
  scope.mark('event_start');
  try { return await work(scoped); }
  catch (error) { scope.status = 'failed'; throw error; }
  finally {
    scope.stopLoading?.();
    scope.mark('handler_done');
    // Record the user's completion before background work can hang or time out.
    emit('line_record_timing');
    scope.phase = 'after_reply';
    // This promise is itself awaited by the webhook's ctx.waitUntil chain.
    await Promise.allSettled([...scope.effects].map(async ([key, effect]) => {
      const label = key.split(':')[0];
      try { await measureEvent(scoped, `after:${label}`, effect); }
      catch { console.warn('line_background_failed', { task: label }); }
    }));
    await scope.loadingDone;
    scope.mark('all_done');
    if (scope.effects.size) emit('line_record_background');
  }
}
