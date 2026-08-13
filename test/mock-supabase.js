/* Test-only stand-in for supabase-js.
   Implements the PostgREST subset the app uses, backed by localStorage so two
   tabs share one "database", plus BroadcastChannel to emulate realtime. */
(() => {
  const KEY = '__mockdb__';
  const seedStr = window.__MOCK_SEED__ ? JSON.stringify(window.__MOCK_SEED__) : null;
  if (seedStr && !localStorage.getItem(KEY)) localStorage.setItem(KEY, seedStr);
  const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  const write = db => localStorage.setItem(KEY, JSON.stringify(db));
  const bc = new BroadcastChannel('mockdb');
  const listeners = [];
  bc.onmessage = ev => listeners.forEach(l => l(ev.data));

  const uuid = () => crypto.randomUUID();
  const emit = (table, eventType, rec, old) => {
    const msg = { table, eventType, new: rec, old };
    listeners.forEach(l => l(msg));
    bc.postMessage(msg);
  };

  const DEFAULTS = {
    accounts: { balance: 0, type: 'checking', include_in_net_worth: true, archived: false, sort_order: 0 },
    bills: { amount: 0, recurrence: 'monthly', autopay: false, archived: false },
    bill_payments: { paid: false },
    income: { amount: 0, recurrence: 'once', received: false },
    budget_categories: { monthly_planned_amount: 0, rollover_enabled: false, archived: false, sort_order: 0 },
    budget_entries: { rolled_over_amount: 0 },
    transactions: { amount: 0, kind: 'expense' },
    savings_goals: { target_amount: 0, current_amount: 0, archived: false, sort_order: 0 },
    sinking_funds: { monthly_contribution: 0, current_balance: 0, archived: false, sort_order: 0 },
    sinking_fund_entries: { amount: 0, kind: 'contribution' },
    net_worth_snapshots: { total_assets: 0, total_liabilities: 0 }
  };

  function Q(table) {
    const st = { table, op: 'select', filters: [], rows: null, onConflict: null, patch: null, single: false, wantSelect: false };
    const api = {
      select() { if (st.op === 'select') st.op = 'select'; st.wantSelect = true; return api; },
      eq(col, val) { st.filters.push([col, val]); return api; },
      order() { return api; },
      limit() { return api; },
      single() { st.single = true; return api; },
      maybeSingle() { st.single = true; return api; },
      insert(rows) { st.op = 'insert'; st.rows = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows, opts) { st.op = 'upsert'; st.rows = Array.isArray(rows) ? rows : [rows]; st.onConflict = opts && opts.onConflict; return api; },
      update(patch) { st.op = 'update'; st.patch = patch; return api; },
      delete() { st.op = 'delete'; return api; },
      then(res, rej) { return run().then(res, rej); }
    };
    async function run() {
      await new Promise(r => setTimeout(r, 8));
      const db = read();
      const t = db[st.table] = db[st.table] || [];
      const match = r => st.filters.every(([c, v]) => String(r[c]) === String(v));
      const defaults = DEFAULTS[st.table] || {};
      let out = [];
      if (st.op === 'select') {
        out = t.filter(match);
        if (st.single) {
          if (out.length !== 1) return { data: null, error: { message: 'no rows / multiple rows' } };
          return { data: out[0], error: null };
        }
        return { data: out, error: null };
      }
      if (st.op === 'insert' || st.op === 'upsert') {
        st.rows.forEach(raw => {
          const row = { ...defaults, ...raw };
          Object.keys(row).forEach(k => { if (row[k] === undefined) delete row[k]; });
          let idx = -1;
          if (row.id != null) idx = t.findIndex(r => r.id === row.id);
          else if (st.onConflict) {
            const cols = st.onConflict.split(',').map(s => s.trim());
            idx = t.findIndex(r => cols.every(c => String(r[c]) === String(row[c])));
          }
          if (idx >= 0 && st.op === 'upsert') {
            const merged = { ...t[idx], ...row };
            t[idx] = merged; out.push(merged); emit(st.table, 'UPDATE', merged);
          } else {
            const rec = { id: row.id || uuid(), created_at: new Date().toISOString(), ...row };
            if (st.table === 'household_settings') rec.id = row.id;
            t.push(rec); out.push(rec); emit(st.table, 'INSERT', rec);
          }
        });
        write(db);
        return { data: out, error: null };
      }
      if (st.op === 'update') {
        t.forEach((r, i) => { if (match(r)) { t[i] = { ...r, ...st.patch }; out.push(t[i]); emit(st.table, 'UPDATE', t[i]); } });
        write(db);
        return { data: out, error: null };
      }
      if (st.op === 'delete') {
        const keep = [], gone = [];
        t.forEach(r => (match(r) ? gone : keep).push(r));
        db[st.table] = keep; write(db);
        gone.forEach(r => emit(st.table, 'DELETE', null, r));
        return { data: gone, error: null };
      }
      return { data: null, error: { message: 'unsupported op' } };
    }
    return api;
  }

  window.supabase = {
    createClient() {
      return {
        from: table => Q(table),
        channel() {
          const subs = [];
          const ch = {
            on(_ev, cfg, cb) { subs.push({ table: cfg.table, cb }); return ch; },
            subscribe(cb) {
              const l = msg => subs.forEach(s => { if (s.table === msg.table) s.cb({ eventType: msg.eventType, new: msg.new, old: msg.old }); });
              listeners.push(l);
              ch._l = l;
              setTimeout(() => cb && cb('SUBSCRIBED'), 30);
              return ch;
            }
          };
          return ch;
        },
        removeChannel(ch) { const i = listeners.indexOf(ch && ch._l); if (i >= 0) listeners.splice(i, 1); }
      };
    }
  };
})();
