/* =====================================================================
   Household Budget Tracker — Sean & Jessica Roper
   PWA + Supabase (live sync across devices), shared household password.
   ===================================================================== */

const CFG = {
  url: 'https://hrtuhexblsbdjfdbfblg.supabase.co',
  key: 'sb_publishable_3YxbUs181JkWsR9Xe5_tow_BAF9GsQS',
  appName: 'Household Budget Tracker',
  version: 'v1.0.0'
};

const sb = supabase.createClient(CFG.url, CFG.key, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 4 } }
});

/* ------------------------- tiny helpers ------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, html) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2));

const money = (v, opts = {}) => {
  const n = num(v);
  const s = n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.cents === false ? 0 : 2,
    maximumFractionDigits: opts.cents === false ? 0 : 2
  });
  return opts.sign && n > 0 ? '+' + s : s;
};
const money0 = v => money(v, { cents: false });

/* ------------------------- dates (local, no TZ drift) ------------------------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = s => { if (!s) return null; const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth() + n, 1); const dim = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); x.setDate(Math.min(d.getDate(), dim)); return x; };
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
const monthStart = d => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd = d => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const fmtD = (s, o = { month: 'short', day: 'numeric' }) => { const d = parseD(s); return d ? d.toLocaleDateString('en-US', o) : '—'; };
const fmtMonth = d => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const fmtMonthShort = d => d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const relDue = ds => {
  const n = daysBetween(today(), parseD(ds));
  if (n === 0) return 'Due today';
  if (n === 1) return 'Due tomorrow';
  if (n === -1) return '1 day overdue';
  if (n < 0) return `${-n} days overdue`;
  return `Due in ${n} days`;
};

const ACCOUNT_TYPES = [
  { v: 'checking', l: 'Checking', asset: true },
  { v: 'savings', l: 'Savings', asset: true },
  { v: 'cash', l: 'Cash', asset: true },
  { v: 'investment', l: 'Investment / Retirement', asset: true },
  { v: 'property', l: 'Property / Vehicle (asset)', asset: true },
  { v: 'credit', l: 'Credit Card (debt)', asset: false },
  { v: 'loan', l: 'Loan / Mortgage (debt)', asset: false },
  { v: 'other', l: 'Other', asset: true }
];
const isDebt = a => a.type === 'credit' || a.type === 'loan';
const typeLabel = t => (ACCOUNT_TYPES.find(x => x.v === t) || { l: t }).l;

const RECURRENCE = [
  { v: 'once', l: 'One-time' },
  { v: 'weekly', l: 'Weekly' },
  { v: 'biweekly', l: 'Every 2 weeks' },
  { v: 'semimonthly', l: 'Twice a month (1st & 15th)' },
  { v: 'monthly', l: 'Monthly' },
  { v: 'quarterly', l: 'Quarterly' },
  { v: 'semiannual', l: 'Every 6 months' },
  { v: 'annual', l: 'Yearly' }
];
const recLabel = v => (RECURRENCE.find(x => x.v === v) || { l: v }).l;

const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'];
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ------------------------- app state ------------------------- */
const S = {
  view: 'dashboard',
  month: monthStart(today()),
  trendMode: 'chart',
  data: {
    settings: null, accounts: [], bills: [], bill_payments: [], income: [],
    budget_categories: [], budget_entries: [], transactions: [],
    savings_goals: [], sinking_funds: [], sinking_fund_entries: [], net_worth_snapshots: []
  },
  loaded: false
};
const TABLES = ['accounts', 'bills', 'bill_payments', 'income', 'budget_categories', 'budget_entries',
  'transactions', 'savings_goals', 'sinking_funds', 'sinking_fund_entries', 'net_worth_snapshots'];

const D = S.data;
const cats = () => D.budget_categories.filter(c => !c.archived).sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
const accts = () => D.accounts.filter(a => !a.archived).sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
const catName = id => (D.budget_categories.find(c => c.id === id) || {}).name || 'Uncategorized';
const acctName = id => (D.accounts.find(a => a.id === id) || {}).name || '—';

/* ------------------------- toast ------------------------- */
let toastT;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

/* ------------------------- password gate ------------------------- */
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const LS_KEY = 'hbt_auth_v1';

async function tryUnlock(pw, remember) {
  const { data, error } = await sb.from('household_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  const hash = await sha256(pw);
  if (hash !== data.password_hash) return false;
  S.data.settings = data;
  if (remember) localStorage.setItem(LS_KEY, hash);
  return true;
}

async function autoUnlock() {
  const saved = localStorage.getItem(LS_KEY);
  if (!saved) return false;
  try {
    const { data, error } = await sb.from('household_settings').select('*').eq('id', 1).single();
    if (error || !data) return false;
    if (data.password_hash !== saved) { localStorage.removeItem(LS_KEY); return false; }
    S.data.settings = data;
    return true;
  } catch { return false; }
}

/* ------------------------- data layer ------------------------- */
async function loadAll() {
  const res = await Promise.all(TABLES.map(t => sb.from(t).select('*')));
  res.forEach((r, i) => {
    if (r.error) { console.error(TABLES[i], r.error); return; }
    D[TABLES[i]] = r.data || [];
  });
  S.loaded = true;
}

async function save(table, row, opts = {}) {
  const payload = { ...row };
  const { data, error } = await sb.from(table).upsert(payload).select();
  if (error) { console.error(error); toast('Save failed: ' + error.message, 3600); throw error; }
  const rec = data && data[0];
  if (rec) {
    const arr = D[table];
    const i = arr.findIndex(x => x.id === rec.id);
    if (i >= 0) arr[i] = rec; else arr.push(rec);
  }
  if (!opts.silent) toast(opts.msg || 'Saved');
  render();
  return rec;
}

async function remove(table, id) {
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, 3600); throw error; }
  D[table] = D[table].filter(x => x.id !== id);
  toast('Deleted'); render();
}

/* live sync */
let chan = null, syncOk = true;
function setSync(ok, label) {
  syncOk = ok;
  $('#syncDot').className = 'dot' + (ok ? '' : ' off');
  $('#syncTxt').textContent = label || (ok ? 'Live' : 'Offline');
}
function startRealtime() {
  if (chan) sb.removeChannel(chan);
  chan = sb.channel('hbt-sync');
  TABLES.forEach(t => {
    chan.on('postgres_changes', { event: '*', schema: 'public', table: t }, payload => {
      const arr = D[t];
      if (payload.eventType === 'DELETE') {
        const id = payload.old && payload.old.id;
        D[t] = arr.filter(x => x.id !== id);
      } else {
        const rec = payload.new;
        const i = arr.findIndex(x => x.id === rec.id);
        if (i >= 0) arr[i] = rec; else arr.push(rec);
      }
      scheduleRender();
    });
  });
  chan.subscribe(status => {
    if (status === 'SUBSCRIBED') setSync(true, 'Live');
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSync(false, 'Reconnecting');
    else if (status === 'CLOSED') setSync(false, 'Offline');
  });
}
let rT; const scheduleRender = () => { clearTimeout(rT); rT = setTimeout(render, 120); };

window.addEventListener('online', () => { setSync(true, 'Live'); refresh(); });
window.addEventListener('offline', () => setSync(false, 'Offline'));
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.loaded) refresh(); });
async function refresh() { try { await loadAll(); render(); } catch (e) { console.error(e); } }

/* =====================================================================
   Bill occurrence engine
   ===================================================================== */
function occurrences(bill, from, to) {
  const out = [];
  const anchor = parseD(bill.due_date);
  if (!anchor) return out;
  const r = bill.recurrence || 'monthly';
  if (r === 'once') { if (anchor >= from && anchor <= to) out.push(iso(anchor)); return out; }

  if (r === 'weekly' || r === 'biweekly') {
    const step = r === 'weekly' ? 7 : 14;
    let d = new Date(anchor);
    if (d < from) { const k = Math.ceil(daysBetween(d, from) / step); d = addDays(d, k * step); }
    while (d > from) { const p = addDays(d, -step); if (p < from) break; d = p; }
    while (d <= to) { if (d >= from) out.push(iso(d)); d = addDays(d, step); }
    return out;
  }
  if (r === 'semimonthly') {
    let m = monthStart(from);
    while (m <= to) {
      [1, 15].forEach(day => {
        const d = new Date(m.getFullYear(), m.getMonth(), day);
        if (d >= from && d <= to && d >= anchor) out.push(iso(d));
      });
      m = addMonths(m, 1);
    }
    return out;
  }
  const stepM = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }[r] || 1;
  let n = Math.floor(((from.getFullYear() - anchor.getFullYear()) * 12 + (from.getMonth() - anchor.getMonth())) / stepM) - 1;
  for (let i = 0; i < 400; i++) {
    const d = addMonths(anchor, (n + i) * stepM);
    if (d > to) break;
    if (d >= from && d >= anchor) out.push(iso(d));
  }
  return out;
}

const payKey = (billId, cycle) => billId + '|' + cycle;
let payIndex = new Map();
function reindexPayments() {
  payIndex = new Map();
  D.bill_payments.forEach(p => payIndex.set(payKey(p.bill_id, String(p.cycle_date).slice(0, 10)), p));
}
const getPayment = (billId, cycle) => payIndex.get(payKey(billId, cycle));

/** all bill instances in a window, with paid state */
function billInstances(from, to) {
  const out = [];
  D.bills.filter(b => !b.archived).forEach(b => {
    occurrences(b, from, to).forEach(c => {
      const p = getPayment(b.id, c);
      out.push({
        bill: b, cycle: c, paid: !!(p && p.paid), payment: p,
        amount: p && p.paid_amount != null ? num(p.paid_amount) : num(b.amount)
      });
    });
  });
  return out.sort((a, b) => a.cycle.localeCompare(b.cycle) || a.bill.name.localeCompare(b.bill.name));
}

async function setBillPaid(bill, cycle, paid, fromAccountId, amount) {
  const existing = getPayment(bill.id, cycle);
  const row = {
    id: existing ? existing.id : undefined,
    bill_id: bill.id, cycle_date: cycle, paid,
    paid_date: paid ? iso(today()) : null,
    paid_amount: paid ? num(amount != null ? amount : bill.amount) : null,
    paid_from_account_id: paid ? (fromAccountId || bill.account_id || null) : null
  };
  if (!row.id) delete row.id;
  const rec = await save('bill_payments', row, { silent: true, });
  reindexPayments();
  toast(paid ? `Marked paid — ${bill.name}` : `Marked unpaid — ${bill.name}`);
  return rec;
}

/* =====================================================================
   Budget math
   ===================================================================== */
function entryFor(catId, m) {
  const key = monthKey(m);
  return D.budget_entries.find(e => e.category_id === catId && String(e.month).slice(0, 10) === key);
}
function plannedFor(cat, m) {
  const e = entryFor(cat.id, m);
  const base = e && e.planned_override != null ? num(e.planned_override) : num(cat.monthly_planned_amount);
  const roll = e ? num(e.rolled_over_amount) : 0;
  return { base, roll, total: base + roll };
}
function actualFor(catId, m) {
  const a = monthStart(m), b = monthEnd(m);
  let sum = 0;
  D.transactions.forEach(t => {
    if (t.kind !== 'expense' || t.category_id !== catId) return;
    const d = parseD(t.date); if (d >= a && d <= b) sum += num(t.amount);
  });
  D.bill_payments.forEach(p => {
    if (!p.paid) return;
    const bill = D.bills.find(x => x.id === p.bill_id);
    if (!bill || bill.category_id !== catId) return;
    const d = parseD(p.paid_date || p.cycle_date); if (d >= a && d <= b) sum += num(p.paid_amount != null ? p.paid_amount : bill.amount);
  });
  return sum;
}
function budgetRows(m) {
  return cats().map(c => {
    const p = plannedFor(c, m), actual = actualFor(c.id, m);
    return { cat: c, ...p, actual, variance: p.total - actual };
  });
}
function monthTotals(m) {
  const rows = budgetRows(m);
  const planned = rows.reduce((s, r) => s + r.total, 0);
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  const a = monthStart(m), b = monthEnd(m);
  let inc = 0;
  D.income.forEach(i => { const d = parseD(i.date); if (d >= a && d <= b) inc += num(i.amount); });
  D.transactions.forEach(t => { if (t.kind !== 'income') return; const d = parseD(t.date); if (d >= a && d <= b) inc += num(t.amount); });
  return { planned, actual, income: inc, rows };
}

/** Roll leftover from the previous month into rollover-enabled categories (idempotent per month) */
async function applyRollovers(m) {
  const prev = addMonths(monthStart(m), -1);
  const targets = cats().filter(c => c.rollover_enabled && !entryFor(c.id, m));
  if (!targets.length) return 0;
  const rows = targets.map(c => {
    const p = plannedFor(c, prev), a = actualFor(c.id, prev);
    const left = Math.max(0, p.total - a);
    return { category_id: c.id, month: monthKey(m), rolled_over_amount: Math.round(left * 100) / 100 };
  });
  const { data, error } = await sb.from('budget_entries').upsert(rows, { onConflict: 'category_id,month' }).select();
  if (error) { console.error(error); return 0; }
  (data || []).forEach(rec => {
    const i = D.budget_entries.findIndex(x => x.id === rec.id);
    if (i >= 0) D.budget_entries[i] = rec; else D.budget_entries.push(rec);
  });
  return rows.filter(r => r.rolled_over_amount > 0).length;
}

/* =====================================================================
   Net worth / debt
   ===================================================================== */
function netWorthNow() {
  let assets = 0, liab = 0;
  D.accounts.filter(a => !a.archived && a.include_in_net_worth !== false).forEach(a => {
    if (isDebt(a)) liab += Math.abs(num(a.balance)); else assets += num(a.balance);
  });
  return { assets, liab, net: assets - liab };
}
/** months to payoff; null if never / insufficient data */
function payoffMonths(balance, annualRate, payment) {
  const B = Math.abs(num(balance)), P = num(payment);
  if (B <= 0) return 0;
  if (P <= 0) return null;
  const r = num(annualRate) / 100 / 12;
  if (r <= 0) return Math.ceil(B / P);
  if (P <= B * r) return null;
  return Math.ceil(-Math.log(1 - (B * r) / P) / Math.log(1 + r));
}
function payoffDate(balance, rate, payment) {
  const m = payoffMonths(balance, rate, payment);
  if (m == null) return null;
  return addMonths(today(), m);
}

/* =====================================================================
   Sinking funds
   ===================================================================== */
function fundsDueContribution(m) {
  const key = monthKey(m);
  return D.sinking_funds.filter(f => !f.archived && num(f.monthly_contribution) > 0 &&
    (!f.last_contribution_month || String(f.last_contribution_month).slice(0, 10) < key));
}
async function contributeFunds(m) {
  const due = fundsDueContribution(m);
  if (!due.length) { toast('Contributions already applied'); return; }
  for (const f of due) {
    const amt = num(f.monthly_contribution);
    await sb.from('sinking_fund_entries').insert({ fund_id: f.id, date: iso(today()), amount: amt, kind: 'contribution', notes: 'Monthly contribution' });
    await save('sinking_funds', {
      id: f.id, name: f.name, target_amount: f.target_amount, monthly_contribution: f.monthly_contribution,
      current_balance: num(f.current_balance) + amt, last_contribution_month: monthKey(m),
      notes: f.notes, archived: f.archived, sort_order: f.sort_order
    }, { silent: true });
  }
  await loadAll();
  toast(`Added ${money(due.reduce((s, f) => s + num(f.monthly_contribution), 0))} to ${due.length} fund${due.length > 1 ? 's' : ''}`);
  render();
}

/* =====================================================================
   Charts (validated palette, SVG, hover layer, table fallback)
   ===================================================================== */
function lineChart(container, points, opts = {}) {
  // points: [{label, value, key}]
  const W = 640, H = opts.height || 190, PL = 52, PR = 14, PT = 14, PB = 26;
  if (points.length < 2) { container.innerHTML = '<div class="empty">Need at least 2 snapshots to chart a trend.</div>'; return; }
  const vals = points.map(p => p.value);
  let min = Math.min(...vals, 0), max = Math.max(...vals, 0);
  if (max === min) { max = min + 1; }
  const padY = (max - min) * 0.12; max += padY; min -= padY;
  const x = i => PL + (i * (W - PL - PR)) / (points.length - 1);
  const y = v => PT + (H - PT - PB) * (1 - (v - min) / (max - min));
  const color = cssv(opts.color || '--s1');

  const ticks = 4, tickVals = [];
  for (let i = 0; i <= ticks; i++) tickVals.push(min + ((max - min) * i) / ticks);
  const zeroY = min < 0 && max > 0 ? y(0) : null;

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.length - 1).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} L${x(0).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} Z`;

  const labelEvery = Math.ceil(points.length / 6);
  const svg = `
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || 'Trend chart')}" preserveAspectRatio="none">
    <defs><linearGradient id="g_${opts.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".22"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${tickVals.map(v => `<line x1="${PL}" x2="${W - PR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${cssv('--grid')}" stroke-width="1"/>
      <text x="${PL - 7}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${cssv('--muted')}" font-family="${cssv('--font') || 'system-ui'}">${money0(v)}</text>`).join('')}
    ${zeroY != null ? `<line x1="${PL}" x2="${W - PR}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="${cssv('--axis')}" stroke-width="1.5"/>` : ''}
    <path d="${area}" fill="url(#g_${opts.id})"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${i === points.length - 1 ? 4.5 : 3}" fill="${color}" stroke="${cssv('--chart-surface')}" stroke-width="2"/>`).join('')}
    ${points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1)
      ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${cssv('--muted')}">${esc(p.label)}</text>` : '').join('')}
    <line id="cross_${opts.id}" x1="0" x2="0" y1="${PT}" y2="${H - PB}" stroke="${cssv('--axis')}" stroke-width="1" opacity="0"/>
    <rect x="${PL}" y="0" width="${W - PL - PR}" height="${H}" fill="transparent" id="hit_${opts.id}"/>
  </svg>
  <div class="tip" id="tip_${opts.id}"></div>`;
  container.innerHTML = svg;

  const hit = $('#hit_' + opts.id, container), tip = $('#tip_' + opts.id, container), cross = $('#cross_' + opts.id, container);
  const move = ev => {
    const r = container.getBoundingClientRect();
    const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    const rel = (px / r.width) * W;
    let i = Math.round(((rel - PL) / (W - PL - PR)) * (points.length - 1));
    i = Math.max(0, Math.min(points.length - 1, i));
    const p = points[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', '.7');
    tip.innerHTML = `<b>${esc(p.label)}</b><div class="tr"><span>${esc(opts.seriesName || 'Value')}</span><span class="tnum"><b style="display:inline">${money(p.value)}</b></span></div>` +
      (p.extra || '');
    tip.style.left = Math.max(60, Math.min(r.width - 60, (x(i) / W) * r.width)) + 'px';
    tip.style.top = ((y(p.value) / H) * r.height - 8) + 'px';
    tip.classList.add('on');
  };
  const out = () => { tip.classList.remove('on'); cross.setAttribute('opacity', '0'); };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', out);
  container.addEventListener('pointerleave', out);
}

function stackedBarChart(container, months, series, opts = {}) {
  // months: [{key,label}]  series: [{name, color, values:[]}]
  const W = 640, H = opts.height || 210, PL = 52, PR = 10, PT = 12, PB = 26;
  const totals = months.map((_, i) => series.reduce((s, sr) => s + num(sr.values[i]), 0));
  let max = Math.max(...totals, 1);
  max = max * 1.08;
  const bw = Math.min(46, ((W - PL - PR) / months.length) * 0.62);
  const cx = i => PL + ((i + 0.5) * (W - PL - PR)) / months.length;
  const y = v => PT + (H - PT - PB) * (1 - v / max);
  const ticks = 4, tickVals = [];
  for (let i = 0; i <= ticks; i++) tickVals.push((max * i) / ticks);
  const surface = cssv('--chart-surface');

  let bars = '';
  months.forEach((m, i) => {
    let acc = 0;
    series.forEach((sr, si) => {
      const v = num(sr.values[i]); if (v <= 0) return;
      const y1 = y(acc + v), y0 = y(acc);
      const h = Math.max(1, y0 - y1 - 2); // 2px surface gap between segments
      bars += `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${acc === 0 ? 0 : 0}" fill="${sr.color}"/>`;
      acc += v;
    });
    // rounded cap on the data-end
    if (acc > 0) {
      bars += `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${y(acc).toFixed(1)}" width="${bw.toFixed(1)}" height="8" rx="4" fill="${series.slice().reverse().find(sr => num(sr.values[i]) > 0)?.color || surface}"/>`;
    }
  });

  container.innerHTML = `
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || 'Spending by category')}" preserveAspectRatio="none">
    ${tickVals.map(v => `<line x1="${PL}" x2="${W - PR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${cssv('--grid')}" stroke-width="1"/>
      <text x="${PL - 7}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${cssv('--muted')}">${money0(v)}</text>`).join('')}
    ${bars}
    ${months.map((m, i) => `<text x="${cx(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${cssv('--muted')}">${esc(m.label)}</text>`).join('')}
    ${months.map((m, i) => `<rect class="hitcol" data-i="${i}" x="${(cx(i) - (W - PL - PR) / months.length / 2).toFixed(1)}" y="0" width="${((W - PL - PR) / months.length).toFixed(1)}" height="${H - PB}" fill="transparent"/>`).join('')}
  </svg>
  <div class="tip" id="tipbar"></div>`;

  const tip = $('#tipbar', container);
  $$('.hitcol', container).forEach(r => {
    const show = ev => {
      const i = +r.dataset.i, rect = container.getBoundingClientRect();
      const rows = series.map(sr => ({ n: sr.name, c: sr.color, v: num(sr.values[i]) })).filter(x => x.v > 0)
        .sort((a, b) => b.v - a.v);
      tip.innerHTML = `<b>${esc(months[i].label)} · ${money0(totals[i])}</b>` +
        rows.map(x => `<div class="tr"><span style="display:flex;align-items:center;gap:5px"><i style="width:8px;height:8px;border-radius:2px;background:${x.c};display:inline-block"></i>${esc(x.n)}</span><span class="tnum">${money0(x.v)}</span></div>`).join('');
      tip.style.left = Math.max(80, Math.min(rect.width - 80, (cx(i) / W) * rect.width)) + 'px';
      tip.style.top = ((y(totals[i]) / H) * rect.height - 8) + 'px';
      tip.classList.add('on');
    };
    r.addEventListener('pointerenter', show);
    r.addEventListener('pointerdown', show);
  });
  container.addEventListener('pointerleave', () => tip.classList.remove('on'));
}

/* =====================================================================
   Sheet (bottom modal) infrastructure
   ===================================================================== */
let sheetOpen = false;
function openSheet(title, buildBody, footerButtons) {
  const sh = $('#sheet'), bg = $('#sheetBg');
  sh.innerHTML = '';
  sh.appendChild(el('div', { class: 'grab' }));
  const head = el('div', { class: 'sheet-h' });
  head.appendChild(el('h3', {}, esc(title)));
  const close = el('button', { class: 'iconbtn', 'aria-label': 'Close' }, '✕');
  close.onclick = closeSheet;
  head.appendChild(close);
  sh.appendChild(head);
  const body = el('div', {});
  sh.appendChild(body);
  buildBody(body);
  if (footerButtons && footerButtons.length) {
    const foot = el('div', { class: 'sheet-foot' });
    footerButtons.forEach(b => {
      const btn = el('button', { class: 'btn ' + (b.cls || '') }, esc(b.label));
      btn.onclick = b.onClick;
      foot.appendChild(btn);
    });
    sh.appendChild(foot);
  }
  sh.classList.remove('hidden'); bg.classList.remove('hidden');
  requestAnimationFrame(() => { sh.classList.add('on'); bg.classList.add('on'); });
  sheetOpen = true;
}
function closeSheet() {
  const sh = $('#sheet'), bg = $('#sheetBg');
  sh.classList.remove('on'); bg.classList.remove('on');
  setTimeout(() => { sh.classList.add('hidden'); bg.classList.add('hidden'); sh.innerHTML = ''; }, 240);
  sheetOpen = false;
}
$('#sheetBg').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen) closeSheet(); });

/* form field builders */
function field(parent, label, inputNode) {
  const l = el('label', { class: 'f' });
  l.appendChild(el('span', {}, esc(label)));
  l.appendChild(inputNode);
  parent.appendChild(l);
  return inputNode;
}
function inp(type, value, attrs = {}) {
  const n = el('input', { type, ...attrs });
  if (value !== null && value !== undefined) n.value = value;
  return n;
}
function sel(options, value, attrs = {}) {
  const s = el('select', attrs);
  options.forEach(o => {
    const op = el('option', { value: o.v }, esc(o.l));
    if (String(o.v) === String(value)) op.selected = true;
    s.appendChild(op);
  });
  return s;
}
function money_(value, attrs = {}) { return inp('number', value != null ? value : '', { step: '0.01', inputmode: 'decimal', placeholder: '0.00', ...attrs }); }
function checkbox(parent, label, checked) {
  const l = el('label', { class: 'chk' });
  const c = el('input', { type: 'checkbox' }); c.checked = !!checked;
  l.appendChild(c); l.appendChild(el('span', {}, esc(label)));
  parent.appendChild(l);
  return c;
}
const catOptions = (includeBlank = true) => (includeBlank ? [{ v: '', l: '— none —' }] : []).concat(cats().map(c => ({ v: c.id, l: c.name })));
const acctOptions = (includeBlank = true) => (includeBlank ? [{ v: '', l: '— none —' }] : []).concat(accts().map(a => ({ v: a.id, l: a.name })));

function confirmDelete(what, fn) {
  openSheet('Delete ' + what + '?', b => {
    b.appendChild(el('p', { class: 'sub' }, `This permanently removes it for both of you. This can't be undone.`));
  }, [
    { label: 'Cancel', cls: 'ghost', onClick: closeSheet },
    { label: 'Delete', cls: 'dang', onClick: async () => { closeSheet(); await fn(); } }
  ]);
}

/* =====================================================================
   Entity editors
   ===================================================================== */
function editAccount(a) {
  const isNew = !a;
  a = a || { name: '', type: 'checking', balance: 0, include_in_net_worth: true };
  openSheet(isNew ? 'New account' : 'Edit account', b => {
    const name = field(b, 'Account name', inp('text', a.name, { placeholder: 'e.g. Primary Checking' }));
    const type = field(b, 'Type', sel(ACCOUNT_TYPES.map(t => ({ v: t.v, l: t.l })), a.type));
    const bal = field(b, 'Current balance', money_(a.balance));
    const balHint = el('div', { class: 'sub', style: 'margin-top:5px' }, 'For credit cards and loans, enter the amount owed as a positive number.');
    b.appendChild(balHint);
    const inst = field(b, 'Institution (optional)', inp('text', a.institution || '', { placeholder: 'Bank name' }));

    const debtBox = el('div', {});
    b.appendChild(debtBox);
    let rate, minp, tdate;
    const drawDebt = () => {
      debtBox.innerHTML = '';
      if (type.value === 'credit' || type.value === 'loan') {
        debtBox.appendChild(el('hr', { class: 'sep' }));
        debtBox.appendChild(el('div', { class: 'sub', style: 'font-weight:620;color:var(--ink-2)' }, 'Debt payoff details (optional)'));
        const g = el('div', { class: 'f2' }); debtBox.appendChild(g);
        rate = field(g, 'Interest rate %', inp('number', a.interest_rate != null ? a.interest_rate : '', { step: '0.01', inputmode: 'decimal', placeholder: '0.00' }));
        minp = field(g, 'Monthly payment', money_(a.minimum_payment));
        tdate = field(debtBox, 'Target payoff date', inp('date', a.target_payoff_date || ''));
      } else { rate = minp = tdate = null; }
    };
    type.onchange = drawDebt; drawDebt();

    const nw = checkbox(b, 'Include in net worth', a.include_in_net_worth !== false);
    const notes = field(b, 'Notes', el('textarea', { placeholder: 'Optional' }, esc(a.notes || '')));

    b._get = () => ({
      id: a.id, name: name.value.trim() || 'Untitled account', type: type.value,
      balance: num(bal.value), institution: inst.value.trim() || null,
      interest_rate: rate && rate.value !== '' ? num(rate.value) : null,
      minimum_payment: minp && minp.value !== '' ? num(minp.value) : null,
      target_payoff_date: tdate && tdate.value ? tdate.value : null,
      include_in_net_worth: nw.checked, notes: notes.value.trim() || null,
      sort_order: a.sort_order || (D.accounts.length + 1) * 10, archived: !!a.archived,
      updated_at: new Date().toISOString()
    });
  }, [
    ...(isNew ? [] : [{ label: 'Delete', cls: 'dang', onClick: () => confirmDelete('account', () => remove('accounts', a.id)) }]),
    { label: 'Save', cls: 'pri', onClick: async () => { const row = sheetGet(); closeSheet(); await save('accounts', row); } }
  ]);
}
/* helper so footer buttons can read the body's _get */
function sheetGet() {
  const sh = $('#sheet');
  const bodies = [...sh.children].filter(c => c._get);
  return bodies.length ? bodies[bodies.length - 1]._get() : {};
}

function editCategory(c) {
  const isNew = !c;
  c = c || { name: '', monthly_planned_amount: 0, rollover_enabled: false };
  openSheet(isNew ? 'New budget category' : 'Edit category', b => {
    const name = field(b, 'Category name', inp('text', c.name, { placeholder: 'e.g. Groceries' }));
    const amt = field(b, 'Planned amount per month', money_(c.monthly_planned_amount));
    const roll = checkbox(b, 'Roll leftover into next month', c.rollover_enabled);
    b.appendChild(el('div', { class: 'sub', style: 'margin-top:6px' },
      'With rollover on, anything left unspent at month end is added to next month\'s plan (good for home repairs or vehicle funds; usually off for groceries).'));
    b._get = () => ({
      id: c.id, name: name.value.trim() || 'Untitled', monthly_planned_amount: num(amt.value),
      rollover_enabled: roll.checked, archived: !!c.archived, sort_order: c.sort_order || (D.budget_categories.length + 1) * 10
    });
  }, [
    ...(isNew ? [] : [{ label: 'Retire', cls: 'ghost', onClick: async () => { closeSheet(); await save('budget_categories', { ...c, archived: true }, { msg: 'Category retired' }); } }]),
    { label: 'Save', cls: 'pri', onClick: async () => { const row = sheetGet(); closeSheet(); await save('budget_categories', row); } }
  ]);
}

function editBill(bl) {
  const isNew = !bl;
  bl = bl || { name: '', amount: 0, due_date: iso(today()), recurrence: 'monthly', autopay: false };
  openSheet(isNew ? 'New bill' : 'Edit bill', b => {
    const name = field(b, 'Bill name', inp('text', bl.name, { placeholder: 'e.g. Electric' }));
    const g = el('div', { class: 'f2' }); b.appendChild(g);
    const amt = field(g, 'Amount', money_(bl.amount));
    const due = field(g, isNew ? 'First due date' : 'Due date (anchor)', inp('date', String(bl.due_date || '').slice(0, 10)));
    const rec = field(b, 'Repeats', sel(RECURRENCE, bl.recurrence));
    const cat = field(b, 'Budget category', sel(catOptions(), bl.category_id || ''));
    const acc = field(b, 'Paid from account', sel(acctOptions(), bl.account_id || ''));
    const auto = checkbox(b, 'Autopay (comes out automatically)', bl.autopay);
    const notes = field(b, 'Notes', el('textarea', {}, esc(bl.notes || '')));
    b._get = () => ({
      id: bl.id, name: name.value.trim() || 'Untitled bill', amount: num(amt.value),
      due_date: due.value || iso(today()), recurrence: rec.value,
      category_id: cat.value || null, account_id: acc.value || null,
      autopay: auto.checked, notes: notes.value.trim() || null, archived: !!bl.archived,
      updated_at: new Date().toISOString()
    });
  }, [
    ...(isNew ? [] : [{ label: 'Delete', cls: 'dang', onClick: () => confirmDelete('bill', () => remove('bills', bl.id)) }]),
    { label: 'Save', cls: 'pri', onClick: async () => { const row = sheetGet(); closeSheet(); await save('bills', row); reindexPayments(); } }
  ]);
}

function editIncome(i) {
  const isNew = !i;
  i = i || { source: '', amount: 0, date: iso(today()), recurrence: 'once', received: false };
  openSheet(isNew ? 'New income' : 'Edit income', b => {
    const src = field(b, 'Source', inp('text', i.source, { placeholder: 'e.g. Sean paycheck' }));
    const g = el('div', { class: 'f2' }); b.appendChild(g);
    const amt = field(g, 'Amount', money_(i.amount));
    const date = field(g, 'Date', inp('date', String(i.date || '').slice(0, 10)));
    const rec = field(b, 'Repeats', sel(RECURRENCE, i.recurrence));
    const acc = field(b, 'Deposited to', sel(acctOptions(), i.account_id || ''));
    const got = checkbox(b, 'Received', i.received);
    const notes = field(b, 'Notes', el('textarea', {}, esc(i.notes || '')));
    b._get = () => ({
      id: i.id, source: src.value.trim() || 'Income', amount: num(amt.value),
      date: date.value || iso(today()), recurrence: rec.value, account_id: acc.value || null,
      received: got.checked, notes: notes.value.trim() || null
    });
  }, [
    ...(isNew ? [] : [{ label: 'Delete', cls: 'dang', onClick: () => confirmDelete('income entry', () => remove('income', i.id)) }]),
    { label: 'Save', cls: 'pri', onClick: async () => { const row = sheetGet(); closeSheet(); await save('income', row); } }
  ]);
}

function editGoal(gl) {
  const isNew = !gl;
  gl = gl || { name: '', target_amount: 0, current_amount: 0 };
  openSheet(isNew ? 'New savings goal' : 'Edit goal', b => {
    const name = field(b, 'Goal name', inp('text', gl.name, { placeholder: 'e.g. New tractor' }));
    const g = el('div', { class: 'f2' }); b.appendChild(g);
    const tgt = field(g, 'Target amount', money_(gl.target_amount));
    const cur = field(g, 'Saved so far', money_(gl.current_amount));
    const date = field(b, 'Target date (optional)', inp('date', gl.target_date || ''));
    const acc = field(b, 'Linked account (optional)', sel(acctOptions(), gl.linked_account_id || ''));
    const notes = field(b, 'Notes', el('textarea', {}, esc(gl.notes || '')));
    b._get = () => ({
      id: gl.id, name: name.value.trim() || 'Goal', target_amount: num(tgt.value),
      current_amount: num(cur.value), target_date: date.value || null,
      linked_account_id: acc.value || null, notes: notes.value.trim() || null,
      archived: !!gl.archived, sort_order: gl.sort_order || (D.savings_goals.length + 1) * 10
    });
  }, [
    ...(isNew ? [] : [{ label: 'Delete', cls: 'dang', onClick: () => confirmDelete('goal', () => remove('savings_goals', gl.id)) }]),
    { label: 'Save', cls: 'pri', onClick: async () => { const row = sheetGet(); closeSheet(); await save('savings_goals', row); } }
  ]);
}

function editFund(f) {
  const isNew = !f;
  f = f || { name: '', monthly_contribution: 0, current_balance: 0 };
  openSheet(isNew ? 'New sinking fund' : 'Edit sinking fund', b => {
    const name = field(b, 'Fund name', inp('text', f.name, { placeholder: 'e.g. Property Taxes' }));
    const g = el('div', { class: 'f2' }); b.appendChild(g);
    const contrib = field(g, 'Monthly contribution', money_(f.monthly_contribution));
    const bal = field(g, 'Current balance', money_(f.current_balance));
    const tgt = field(b, 'Target amount (optional)', money_(f.target_amount));
    const notes = field(b, 'Notes', el('textarea', {}, esc(f.notes || '')));
    b._get = () => ({
      id: f.id, name: name.value.trim() || 'Fund', monthly_contribution: num(contrib.value),
      current_balance: num(bal.value), target_amount: tgt.value !== '' ? num(tgt.value) : null,
      last_contribution_month: f.last_contribution_month || null,
      notes: notes.value.trim() || null, archived: !!f.archived, sort_order: f.sort_order || (D.sinking_funds.length + 1) * 10
    });
  }, [
    ...(isNew ? [] : [{ label: 'Delete', cls: 'dang', onClick: () => confirmDelete('fund', () => remove('sinking_funds', f.id)) }]),
    { label: 'Save', cls: 'pri', onClick: async () => { const row = sheetGet(); closeSheet(); await save('sinking_funds', row); } }
  ]);
}

function fundMove(f, kind) {
  openSheet((kind === 'contribution' ? 'Add to ' : 'Spend from ') + f.name, b => {
    const amt = field(b, 'Amount', money_(kind === 'contribution' ? f.monthly_contribution : ''));
    const date = field(b, 'Date', inp('date', iso(today())));
    const notes = field(b, 'Note', inp('text', '', { placeholder: kind === 'contribution' ? 'Monthly contribution' : 'What was it for?' }));
    b._get = () => ({ amount: num(amt.value), date: date.value, notes: notes.value.trim() || null });
    setTimeout(() => amt.focus(), 250);
  }, [
    { label: 'Cancel', cls: 'ghost', onClick: closeSheet },
    {
      label: kind === 'contribution' ? 'Add' : 'Spend', cls: 'pri', onClick: async () => {
        const v = sheetGet(); closeSheet();
        if (v.amount <= 0) return toast('Enter an amount');
        await sb.from('sinking_fund_entries').insert({ fund_id: f.id, date: v.date, amount: v.amount, kind, notes: v.notes });
        const delta = kind === 'contribution' ? v.amount : -v.amount;
        await save('sinking_funds', { ...f, current_balance: num(f.current_balance) + delta }, { msg: kind === 'contribution' ? 'Added' : 'Recorded' });
        await loadAll(); render();
      }
    }
  ]);
}

function editTransaction(t) {
  const isNew = !t;
  t = t || { date: iso(today()), description: '', amount: 0, kind: 'expense' };
  openSheet(isNew ? 'New transaction' : 'Edit transaction', b => {
    const kind = field(b, 'Type', sel([{ v: 'expense', l: 'Expense' }, { v: 'income', l: 'Income' }], t.kind));
    const desc = field(b, 'Description', inp('text', t.description, { placeholder: 'e.g. Tractor Supply' }));
    const g = el('div', { class: 'f2' }); b.appendChild(g);
    const amt = field(g, 'Amount', money_(t.amount));
    const date = field(g, 'Date', inp('date', String(t.date).slice(0, 10)));
    const cat = field(b, 'Category', sel(catOptions(), t.category_id || ''));
    const acc = field(b, 'Account', sel(acctOptions(), t.account_id || ''));
    b._get = () => ({
      id: t.id, kind: kind.value, description: desc.value.trim(), amount: num(amt.value),
      date: date.value, category_id: cat.value || null, account_id: acc.value || null
    });
  }, [
    ...(isNew ? [] : [{ label: 'Delete', cls: 'dang', onClick: () => confirmDelete('transaction', () => remove('transactions', t.id)) }]),
    { label: 'Save', cls: 'pri', onClick: async () => { const row = sheetGet(); closeSheet(); await save('transactions', row); } }
  ]);
}

/* =====================================================================
   Quick Add — ~10 second entry
   ===================================================================== */
function quickAdd() {
  let mode = 'expense';
  openSheet('Quick add', b => {
    const seg = el('div', { class: 'seg', style: 'margin-bottom:4px' });
    const modes = [['expense', 'Expense'], ['income', 'Income'], ['bill', 'Pay bill']];
    const panel = el('div', {});
    const draw = () => {
      $$('button', seg).forEach(x => x.setAttribute('aria-selected', String(x.dataset.m === mode)));
      panel.innerHTML = '';
      if (mode === 'bill') return drawBillPay(panel);
      const amt = field(panel, 'Amount', money_('', { autofocus: 'true' }));
      const desc = field(panel, mode === 'expense' ? 'What for?' : 'Source', inp('text', '', { placeholder: mode === 'expense' ? 'e.g. Groceries at HEB' : 'e.g. Side job' }));
      const cat = field(panel, 'Category', sel(catOptions(), ''));
      const g = el('div', { class: 'f2' }); panel.appendChild(g);
      const acc = field(g, 'Account', sel(acctOptions(), ''));
      const date = field(g, 'Date', inp('date', iso(today())));
      panel._get = () => ({ kind: mode, amount: num(amt.value), description: desc.value.trim(), category_id: cat.value || null, account_id: acc.value || null, date: date.value });
      setTimeout(() => amt.focus(), 260);
    };
    modes.forEach(([m, l]) => {
      const btn = el('button', { 'data-m': m }, l);
      btn.onclick = () => { mode = m; draw(); };
      seg.appendChild(btn);
    });
    b.appendChild(seg); b.appendChild(panel);
    b._get = () => (panel._get ? panel._get() : null);
    draw();
  }, [
    { label: 'Cancel', cls: 'ghost', onClick: closeSheet },
    {
      label: 'Add', cls: 'pri', onClick: async () => {
        const v = sheetGet();
        if (!v) { closeSheet(); return; }
        if (!v.amount || v.amount <= 0) return toast('Enter an amount');
        closeSheet();
        await save('transactions', v, { msg: (v.kind === 'income' ? 'Income' : 'Expense') + ' added' });
      }
    }
  ]);

  function drawBillPay(panel) {
    const from = addDays(today(), -45), to = addDays(today(), 30);
    const list = billInstances(from, to).filter(x => !x.paid);
    if (!list.length) { panel.appendChild(el('div', { class: 'empty' }, 'No unpaid bills in the last 45 / next 30 days.')); panel._get = () => null; return; }
    list.slice(0, 40).forEach(x => {
      const overdue = parseD(x.cycle) < today();
      const row = el('button', { class: 'row rowbtn' });
      row.innerHTML = `<div class="main"><div class="t">${esc(x.bill.name)}</div>
        <div class="s">${fmtD(x.cycle, { month: 'short', day: 'numeric' })} · ${esc(catName(x.bill.category_id))}</div></div>
        <div class="amt">${money(x.amount)}</div>
        <span class="badge ${overdue ? 'b-over' : 'b-soon'}">${overdue ? 'Overdue' : 'Due'}</span>`;
      row.onclick = async () => { closeSheet(); await setBillPaid(x.bill, x.cycle, true); };
      panel.appendChild(row);
    });
    panel._get = () => null;
  }
}

/* =====================================================================
   Shared view pieces
   ===================================================================== */
function sectionCard(title, actionLabel, onAction) {
  const c = el('div', { class: 'card' });
  const h = el('div', { class: 'card-h' });
  h.appendChild(el('h2', {}, esc(title)));
  if (actionLabel) {
    const b = el('button', { class: 'link' }, esc(actionLabel));
    b.onclick = onAction; h.appendChild(b);
  }
  c.appendChild(h);
  return c;
}
function emptyNote(txt) { return el('div', { class: 'empty' }, esc(txt)); }

function monthNav(onChange) {
  const w = el('div', { class: 'card' });
  const n = el('div', { class: 'month-nav' });
  const prev = el('button', { class: 'iconbtn' }, '‹');
  const next = el('button', { class: 'iconbtn' }, '›');
  const lab = el('b', {}, esc(fmtMonth(S.month)));
  prev.onclick = () => { S.month = addMonths(S.month, -1); onChange(); };
  next.onclick = () => { S.month = addMonths(S.month, 1); onChange(); };
  n.append(prev, lab, next);
  w.appendChild(n);
  const isNow = monthKey(S.month) === monthKey(today());
  if (!isNow) {
    const t = el('button', { class: 'btn sm ghost wide', style: 'margin-top:10px' }, 'Back to this month');
    t.onclick = () => { S.month = monthStart(today()); onChange(); };
    w.appendChild(t);
  }
  return w;
}

function billRow(x, opts = {}) {
  const overdue = !x.paid && parseD(x.cycle) < today();
  const soon = !x.paid && !overdue && daysBetween(today(), parseD(x.cycle)) <= 7;
  const row = el('div', { class: 'row' });
  const left = el('button', { class: 'rowbtn', style: 'flex:1' });
  left.innerHTML = `<div class="main">
      <div class="t">${esc(x.bill.name)} ${x.bill.autopay ? '<span class="badge b-mut">auto</span>' : ''}</div>
      <div class="s">${fmtD(x.cycle, { month: 'short', day: 'numeric' })} · ${esc(catName(x.bill.category_id))}${x.bill.account_id ? ' · ' + esc(acctName(x.bill.account_id)) : ''}</div>
    </div>
    <div class="amt">${money(x.amount)}</div>`;
  left.onclick = () => editBill(x.bill);
  row.appendChild(left);

  const badge = el('span', { class: 'badge ' + (x.paid ? 'b-ok' : overdue ? 'b-over' : soon ? 'b-soon' : 'b-mut') },
    x.paid ? '✓ Paid' : overdue ? 'Overdue' : soon ? relDue(x.cycle).replace('Due in ', 'in ') : 'Upcoming');
  row.appendChild(badge);

  const tog = el('button', { class: 'btn sm ' + (x.paid ? 'ghost' : 'olive'), style: 'margin-left:4px' }, x.paid ? 'Undo' : 'Pay');
  tog.onclick = async e => { e.stopPropagation(); await setBillPaid(x.bill, x.cycle, !x.paid); };
  row.appendChild(tog);
  return row;
}

function progressRow(name, current, target, opts = {}) {
  const pct = target > 0 ? Math.min(1, current / target) : 0;
  const wrap = el('div', { style: 'padding:11px 4px;border-bottom:1px solid var(--line)' });
  wrap.innerHTML = `<div style="display:flex;gap:8px;align-items:baseline;margin-bottom:6px">
      <div style="flex:1;font-weight:560;font-size:14.5px">${esc(name)}</div>
      <div class="tnum" style="font-size:13.5px;font-weight:620">${money0(current)}${target > 0 ? ` <span style="color:var(--muted);font-weight:500">/ ${money0(target)}</span>` : ''}</div>
    </div>
    <div class="bar ${opts.cls || ''}"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
    ${opts.note ? `<div class="s" style="margin-top:5px;color:var(--muted);font-size:12px">${opts.note}</div>` : ''}`;
  return wrap;
}

/* =====================================================================
   VIEW: Dashboard
   ===================================================================== */
function viewDashboard(app) {
  const nw = netWorthNow();
  const mt = monthTotals(S.month);
  const win = billInstances(addDays(today(), -60), addDays(today(), 14));
  const overdue = win.filter(x => !x.paid && parseD(x.cycle) < today());
  const upcoming = win.filter(x => !x.paid && parseD(x.cycle) >= today());

  /* tiles */
  const tiles = el('div', { class: 'tiles' });
  const cash = accts().filter(a => !isDebt(a) && a.type !== 'property' && a.type !== 'investment')
    .reduce((s, a) => s + num(a.balance), 0);
  const t1 = el('div', { class: 'tile' });
  t1.innerHTML = `<div class="lab">Cash on hand</div><div class="val tnum">${money0(cash)}</div><div class="note">across ${accts().filter(a => !isDebt(a) && a.type !== 'property' && a.type !== 'investment').length} accounts</div>`;
  const t2 = el('div', { class: 'tile' });
  t2.innerHTML = `<div class="lab">Net worth</div><div class="val tnum ${nw.net >= 0 ? 'pos' : 'neg'}">${money0(nw.net)}</div><div class="note">${money0(nw.assets)} assets · ${money0(nw.liab)} debt</div>`;
  const spentPct = mt.planned > 0 ? Math.round((mt.actual / mt.planned) * 100) : 0;
  const t3 = el('div', { class: 'tile' });
  t3.innerHTML = `<div class="lab">Spent this month</div><div class="val tnum">${money0(mt.actual)}</div><div class="note">${mt.planned > 0 ? `${spentPct}% of ${money0(mt.planned)} planned` : 'no plan set yet'}</div>`;
  const left = mt.income - mt.actual;
  const t4 = el('div', { class: 'tile' });
  t4.innerHTML = `<div class="lab">Income this month</div><div class="val tnum">${money0(mt.income)}</div><div class="note ${left >= 0 ? 'pos' : 'neg'}">${left >= 0 ? money0(left) + ' left over' : money0(-left) + ' over income'}</div>`;
  tiles.append(t1, t2, t3, t4);
  app.appendChild(tiles);

  /* bills */
  const bc = sectionCard('Bills', 'All bills →', () => go('bills'));
  if (!overdue.length && !upcoming.length) bc.appendChild(emptyNote(D.bills.length ? 'Nothing due in the next 14 days. Nice.' : 'No bills yet — add your first one.'));
  if (overdue.length) {
    bc.appendChild(el('div', { class: 'sub', style: 'font-weight:640;color:var(--critical-text);margin:4px 0 2px' }, `${overdue.length} overdue · ${money(overdue.reduce((s, x) => s + x.amount, 0))}`));
    overdue.forEach(x => bc.appendChild(billRow(x)));
  }
  if (upcoming.length) {
    bc.appendChild(el('div', { class: 'sub', style: 'font-weight:640;margin:10px 0 2px' }, `Next 14 days · ${money(upcoming.reduce((s, x) => s + x.amount, 0))}`));
    upcoming.slice(0, 8).forEach(x => bc.appendChild(billRow(x)));
  }
  if (!D.bills.length) {
    const add = el('button', { class: 'btn wide', style: 'margin-top:12px' }, '+ Add a bill');
    add.onclick = () => editBill(null); bc.appendChild(add);
  }
  app.appendChild(bc);

  /* sinking fund contribution prompt */
  const due = fundsDueContribution(S.month);
  if (due.length) {
    const p = el('div', { class: 'card', style: 'border-color:var(--accent);background:var(--accent-soft)' });
    p.innerHTML = `<div style="font-weight:620;font-size:14.5px;margin-bottom:4px">Sinking fund contributions</div>
      <div class="sub">${due.length} fund${due.length > 1 ? 's' : ''} haven't had ${fmtMonth(S.month)}'s contribution added — ${money(due.reduce((s, f) => s + num(f.monthly_contribution), 0))} total.</div>`;
    const b = el('button', { class: 'btn pri wide', style: 'margin-top:11px' }, 'Add this month\'s contributions');
    b.onclick = () => contributeFunds(S.month);
    p.appendChild(b);
    app.appendChild(p);
  }

  /* budget snapshot */
  const budRows = mt.rows.filter(r => r.total > 0 || r.actual > 0).sort((a, b) => b.actual - a.actual);
  const buc = sectionCard(`Budget · ${fmtMonth(S.month)}`, 'Open budget →', () => go('budget'));
  if (!budRows.length) buc.appendChild(emptyNote('Set planned amounts on your categories to start tracking.'));
  else {
    const barTotal = el('div', { style: 'margin-bottom:10px' });
    const pct = mt.planned > 0 ? Math.min(1, mt.actual / mt.planned) : 0;
    const overAll = mt.planned > 0 && mt.actual > mt.planned;
    barTotal.innerHTML = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
        <span class="sub">${money(mt.actual)} spent</span><span class="sub">${money(mt.planned)} planned</span></div>
      <div class="bar ${overAll ? 'over' : pct > .85 ? 'warn' : ''}"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>`;
    buc.appendChild(barTotal);
    budRows.slice(0, 5).forEach(r => {
      const over = r.actual > r.total && r.total > 0;
      buc.appendChild(progressRow(r.cat.name, r.actual, r.total, {
        cls: over ? 'over' : (r.total > 0 && r.actual / r.total > .85 ? 'warn' : ''),
        note: r.total > 0 ? (over ? `${money(r.actual - r.total)} over` : `${money(r.total - r.actual)} left`) : 'no plan set'
      }));
    });
  }
  app.appendChild(buc);

  /* net worth trend */
  const snaps = D.net_worth_snapshots.slice().sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
  const nwc = sectionCard('Net worth', 'History →', () => go('networth'));
  const wrap = el('div', { class: 'chartwrap' });
  nwc.appendChild(wrap);
  app.appendChild(nwc);
  setTimeout(() => {
    if (snaps.length >= 2) {
      lineChart(wrap, snaps.map(s => ({
        label: fmtD(s.snapshot_date, { month: 'short', day: 'numeric' }),
        value: num(s.total_assets) - num(s.total_liabilities)
      })), { id: 'nwdash', seriesName: 'Net worth', aria: 'Net worth over time', color: '--s1' });
    } else {
      wrap.innerHTML = '';
      wrap.appendChild(emptyNote('Take a couple of snapshots to see your trend.'));
      const b = el('button', { class: 'btn wide', style: 'margin-top:10px' }, 'Take a snapshot now');
      b.onclick = takeSnapshot; wrap.appendChild(b);
    }
  }, 0);

  /* goals + debt side by side */
  const goals = D.savings_goals.filter(g => !g.archived);
  const debts = accts().filter(isDebt).filter(a => Math.abs(num(a.balance)) > 0);
  const gc = sectionCard('Savings goals', 'Manage →', () => go('savings'));
  if (!goals.length) gc.appendChild(emptyNote('No goals yet.'));
  else goals.slice(0, 4).forEach(g => gc.appendChild(progressRow(g.name, num(g.current_amount), num(g.target_amount), {
    note: g.target_date ? `target ${fmtD(g.target_date, { month: 'short', year: 'numeric' })}` : ''
  })));
  app.appendChild(gc);

  const dc = sectionCard('Debt payoff', 'Manage →', () => go('accounts'));
  if (!debts.length) dc.appendChild(emptyNote('No debt balances tracked. 🎉'));
  else {
    /* how much debt has come down since the earliest snapshot */
    const snapsD = D.net_worth_snapshots.slice().sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
    const startDebt = snapsD.length ? num(snapsD[0].total_liabilities) : null;
    const head = el('div', { style: 'margin-bottom:8px' });
    const paidDown = startDebt != null ? startDebt - nw.liab : null;
    head.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline">
        <span class="sub">Total owed</span><b class="tnum" style="font-size:17px">${money0(nw.liab)}</b></div>` +
      (paidDown != null && Math.abs(paidDown) > 1
        ? `<div class="sub" style="margin-top:3px">${paidDown > 0 ? `${money0(paidDown)} paid down` : `${money0(-paidDown)} added`} since ${fmtD(snapsD[0].snapshot_date, { month: 'short', year: 'numeric' })}</div>`
        : '');
    dc.appendChild(head);
    debts.forEach(a => {
      const pay = payoffDate(a.balance, a.interest_rate, a.minimum_payment);
      const r = el('button', { class: 'row rowbtn' });
      r.innerHTML = `<div class="main"><div class="t">${esc(a.name)}</div>
        <div class="s">${pay ? `est. payoff ${pay.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}${a.interest_rate ? ` · ${a.interest_rate}%` : ''}`
          : (num(a.minimum_payment) > 0 ? 'payment does not cover interest' : 'add a monthly payment for an estimate')}</div></div>
        <div class="amt neg">${money0(Math.abs(num(a.balance)))}</div><span class="chev">›</span>`;
      r.onclick = () => editAccount(a);
      dc.appendChild(r);
    });
  }
  app.appendChild(dc);

  /* sinking funds */
  const funds = D.sinking_funds.filter(f => !f.archived);
  const fc = sectionCard('Sinking funds', 'Manage →', () => go('funds'));
  if (!funds.length) fc.appendChild(emptyNote('No sinking funds yet.'));
  else {
    fc.appendChild(el('div', { class: 'sub', style: 'margin-bottom:6px' },
      `${money(funds.reduce((s, f) => s + num(f.current_balance), 0))} set aside across ${funds.length} funds`));
    funds.forEach(f => fc.appendChild(progressRow(f.name, num(f.current_balance), num(f.target_amount),
      { note: num(f.monthly_contribution) > 0 ? `${money0(f.monthly_contribution)}/mo` : '' })));
  }
  app.appendChild(fc);

  /* weekly review CTA */
  const cta = el('div', { class: 'card', style: 'text-align:center' });
  cta.innerHTML = `<div style="font-weight:620;margin-bottom:3px">Weekly review</div>
    <div class="sub" style="margin-bottom:12px">Sit down together, reconcile balances and clear the week's bills.</div>`;
  const cb = el('button', { class: 'btn olive wide' }, 'Start weekly review');
  cb.onclick = () => go('review'); cta.appendChild(cb);
  app.appendChild(cta);
}

/* =====================================================================
   VIEW: Bills
   ===================================================================== */
function viewBills(app) {
  app.appendChild(monthNav(render));
  const from = monthStart(S.month), to = monthEnd(S.month);
  const list = billInstances(from, to);
  const paid = list.filter(x => x.paid);
  const unpaid = list.filter(x => !x.paid);

  const sum = el('div', { class: 'tiles' });
  const a = el('div', { class: 'tile' });
  a.innerHTML = `<div class="lab">Due this month</div><div class="val tnum">${money0(list.reduce((s, x) => s + x.amount, 0))}</div><div class="note">${list.length} bills</div>`;
  const b = el('div', { class: 'tile' });
  b.innerHTML = `<div class="lab">Still to pay</div><div class="val tnum ${unpaid.length ? 'neg' : 'pos'}">${money0(unpaid.reduce((s, x) => s + x.amount, 0))}</div><div class="note">${paid.length} of ${list.length} paid</div>`;
  sum.append(a, b);
  app.appendChild(sum);

  const c = sectionCard(fmtMonth(S.month) + ' bills', '+ New bill', () => editBill(null));
  if (!list.length) c.appendChild(emptyNote(D.bills.length ? 'No bills fall in this month.' : 'No bills yet — add your first one.'));
  else {
    if (unpaid.length) { c.appendChild(el('div', { class: 'sub', style: 'font-weight:640;margin:2px 0' }, 'Unpaid')); unpaid.forEach(x => c.appendChild(billRow(x))); }
    if (paid.length) { c.appendChild(el('div', { class: 'sub', style: 'font-weight:640;margin:12px 0 2px' }, 'Paid')); paid.forEach(x => c.appendChild(billRow(x))); }
  }
  app.appendChild(c);

  const all = D.bills.filter(x => !x.archived).sort((x, y) => x.name.localeCompare(y.name));
  const ac = sectionCard('All recurring bills', null);
  if (!all.length) ac.appendChild(emptyNote('Nothing set up yet.'));
  all.forEach(bl => {
    const r = el('button', { class: 'row rowbtn' });
    r.innerHTML = `<div class="main"><div class="t">${esc(bl.name)}</div>
      <div class="s">${recLabel(bl.recurrence)} · ${esc(catName(bl.category_id))}${bl.autopay ? ' · autopay' : ''}</div></div>
      <div class="amt">${money(bl.amount)}</div><span class="chev">›</span>`;
    r.onclick = () => editBill(bl);
    ac.appendChild(r);
  });
  app.appendChild(ac);
}

/* =====================================================================
   VIEW: Budget
   ===================================================================== */
function viewBudget(app) {
  app.appendChild(monthNav(render));
  const mt = monthTotals(S.month);
  const tiles = el('div', { class: 'tiles' });
  const t1 = el('div', { class: 'tile' });
  t1.innerHTML = `<div class="lab">Planned</div><div class="val tnum">${money0(mt.planned)}</div>`;
  const t2 = el('div', { class: 'tile' });
  const varc = mt.planned - mt.actual;
  t2.innerHTML = `<div class="lab">Actual</div><div class="val tnum">${money0(mt.actual)}</div><div class="note ${varc >= 0 ? 'pos' : 'neg'}">${varc >= 0 ? money0(varc) + ' under' : money0(-varc) + ' over'}</div>`;
  tiles.append(t1, t2); app.appendChild(tiles);

  const rollBtn = el('button', { class: 'btn wide sm' }, `Roll leftovers in from ${fmtMonthShort(addMonths(S.month, -1))}`);
  rollBtn.onclick = async () => { const n = await applyRollovers(S.month); toast(n ? `Rolled leftovers into ${n} categories` : 'Nothing to roll over'); render(); };

  const c = sectionCard('Categories', '+ New category', () => editCategory(null));
  if (!mt.rows.length) c.appendChild(emptyNote('No categories yet.'));
  mt.rows.forEach(r => {
    const over = r.actual > r.total && r.total > 0;
    const near = r.total > 0 && !over && r.actual / r.total > .85;
    const w = el('div', { style: 'padding:12px 4px;border-bottom:1px solid var(--line)' });
    const pct = r.total > 0 ? Math.min(1, r.actual / r.total) : 0;
    w.innerHTML = `<div style="display:flex;gap:8px;align-items:baseline;margin-bottom:6px">
        <div style="flex:1;font-weight:580;font-size:15px">${esc(r.cat.name)}
          ${r.cat.rollover_enabled ? '<span class="badge b-mut" title="Rolls over">↻</span>' : ''}</div>
        <div class="tnum" style="font-size:14px;font-weight:640">${money0(r.actual)} <span style="color:var(--muted);font-weight:500">/ ${money0(r.total)}</span></div>
      </div>
      <div class="bar ${over ? 'over' : near ? 'warn' : ''}"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:var(--muted)">
        <span>${r.roll > 0 ? `${money0(r.base)} planned + ${money0(r.roll)} rolled over` : `${money0(r.base)} planned`}</span>
        <span class="${over ? 'neg' : 'pos'}" style="font-weight:600">${r.total === 0 ? '' : over ? money0(r.actual - r.total) + ' over' : money0(r.total - r.actual) + ' left'}</span>
      </div>`;
    w.onclick = () => editCategory(r.cat);
    c.appendChild(w);
  });
  c.appendChild(el('div', { style: 'height:12px' }));
  c.appendChild(rollBtn);
  app.appendChild(c);

  /* recent transactions this month */
  const a = monthStart(S.month), z = monthEnd(S.month);
  const tx = D.transactions.filter(t => { const d = parseD(t.date); return d >= a && d <= z; })
    .sort((x, y) => String(y.date).localeCompare(String(x.date)));
  const tc = sectionCard('Transactions this month', '+ Add', () => editTransaction(null));
  if (!tx.length) tc.appendChild(emptyNote('No transactions logged this month. Use the + button for fast entry.'));
  tx.slice(0, 60).forEach(t => {
    const r = el('button', { class: 'row rowbtn' });
    r.innerHTML = `<div class="main"><div class="t">${esc(t.description || catName(t.category_id))}</div>
      <div class="s">${fmtD(t.date)} · ${esc(catName(t.category_id))}${t.account_id ? ' · ' + esc(acctName(t.account_id)) : ''}</div></div>
      <div class="amt ${t.kind === 'income' ? 'pos' : ''}">${t.kind === 'income' ? '+' : ''}${money(t.amount)}</div><span class="chev">›</span>`;
    r.onclick = () => editTransaction(t);
    tc.appendChild(r);
  });
  app.appendChild(tc);

  const arch = D.budget_categories.filter(x => x.archived);
  if (arch.length) {
    const ac = sectionCard('Retired categories', null);
    arch.forEach(x => {
      const r = el('div', { class: 'row' });
      r.innerHTML = `<div class="main"><div class="t" style="color:var(--muted)">${esc(x.name)}</div></div>`;
      const b = el('button', { class: 'btn sm ghost' }, 'Restore');
      b.onclick = () => save('budget_categories', { ...x, archived: false }, { msg: 'Restored' });
      r.appendChild(b); ac.appendChild(r);
    });
    app.appendChild(ac);
  }
}

/* =====================================================================
   VIEW: Accounts (+ debt payoff)
   ===================================================================== */
function viewAccounts(app) {
  const nw = netWorthNow();
  const tiles = el('div', { class: 'tiles' });
  const t1 = el('div', { class: 'tile' });
  t1.innerHTML = `<div class="lab">Assets</div><div class="val tnum pos">${money0(nw.assets)}</div>`;
  const t2 = el('div', { class: 'tile' });
  t2.innerHTML = `<div class="lab">Debt</div><div class="val tnum neg">${money0(nw.liab)}</div>`;
  tiles.append(t1, t2); app.appendChild(tiles);

  const assets = accts().filter(a => !isDebt(a));
  const debts = accts().filter(isDebt);

  const ac = sectionCard('Accounts', '+ New account', () => editAccount(null));
  if (!assets.length) ac.appendChild(emptyNote('No accounts yet.'));
  assets.forEach(a => {
    const r = el('button', { class: 'row rowbtn' });
    r.innerHTML = `<div class="main"><div class="t">${esc(a.name)}</div>
      <div class="s">${esc(typeLabel(a.type))}${a.institution ? ' · ' + esc(a.institution) : ''}</div></div>
      <div class="amt">${money(a.balance)}</div><span class="chev">›</span>`;
    r.onclick = () => editAccount(a);
    ac.appendChild(r);
  });
  app.appendChild(ac);

  const dc = sectionCard('Debt payoff', null);
  if (!debts.length) dc.appendChild(emptyNote('No credit cards or loans tracked.'));
  debts.forEach(a => {
    const bal = Math.abs(num(a.balance));
    const months = payoffMonths(bal, a.interest_rate, a.minimum_payment);
    const pd = payoffDate(bal, a.interest_rate, a.minimum_payment);
    const totalInterest = months != null && num(a.minimum_payment) > 0 ? Math.max(0, months * num(a.minimum_payment) - bal) : null;
    const w = el('div', { style: 'padding:12px 4px;border-bottom:1px solid var(--line)' });
    w.innerHTML = `<div style="display:flex;gap:8px;align-items:baseline">
        <div style="flex:1;font-weight:580;font-size:15px">${esc(a.name)}</div>
        <div class="tnum" style="font-weight:660;font-size:15px">${money(bal)}</div></div>
      <div class="s" style="margin-top:3px">${esc(typeLabel(a.type))}${a.interest_rate ? ` · ${a.interest_rate}% APR` : ''}${num(a.minimum_payment) > 0 ? ` · ${money0(a.minimum_payment)}/mo` : ''}</div>
      <div class="kv" style="margin-top:6px;border-top:1px solid var(--line);padding-top:8px">
        <span>Estimated payoff</span>
        <b>${pd ? pd.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ` (${months} mo)` : (num(a.minimum_payment) > 0 ? 'never at this payment' : 'add a monthly payment')}</b>
      </div>
      ${totalInterest != null ? `<div class="kv"><span>Interest you'll pay</span><b>${money0(totalInterest)}</b></div>` : ''}
      ${a.target_payoff_date ? `<div class="kv"><span>Your target</span><b>${fmtD(a.target_payoff_date, { month: 'long', year: 'numeric' })}</b></div>` : ''}`;
    const b = el('button', { class: 'btn sm wide ghost', style: 'margin-top:8px' }, 'Update balance / details');
    b.onclick = () => editAccount(a);
    w.appendChild(b);
    dc.appendChild(w);
  });
  app.appendChild(dc);

  const arch = D.accounts.filter(a => a.archived);
  if (arch.length) {
    const c = sectionCard('Archived accounts', null);
    arch.forEach(a => {
      const r = el('div', { class: 'row' });
      r.innerHTML = `<div class="main"><div class="t" style="color:var(--muted)">${esc(a.name)}</div></div>`;
      const b = el('button', { class: 'btn sm ghost' }, 'Restore');
      b.onclick = () => save('accounts', { ...a, archived: false }, { msg: 'Restored' });
      r.appendChild(b); c.appendChild(r);
    });
    app.appendChild(c);
  }
}

/* =====================================================================
   VIEW: Income
   ===================================================================== */
function viewIncome(app) {
  app.appendChild(monthNav(render));
  const a = monthStart(S.month), z = monthEnd(S.month);
  const inMonth = D.income.filter(i => { const d = parseD(i.date); return d >= a && d <= z; });
  const txIn = D.transactions.filter(t => t.kind === 'income' && (() => { const d = parseD(t.date); return d >= a && d <= z; })());
  const total = inMonth.reduce((s, i) => s + num(i.amount), 0) + txIn.reduce((s, t) => s + num(t.amount), 0);

  const tile = el('div', { class: 'tile' });
  tile.innerHTML = `<div class="lab">Income · ${esc(fmtMonth(S.month))}</div><div class="val tnum pos">${money0(total)}</div>
    <div class="note">${inMonth.length + txIn.length} entries</div>`;
  app.appendChild(el('div', { class: 'tiles', style: 'grid-template-columns:1fr' })).appendChild(tile);

  const c = sectionCard('Income this month', '+ New income', () => editIncome(null));
  if (!inMonth.length && !txIn.length) c.appendChild(emptyNote('Nothing logged for this month.'));
  inMonth.sort((x, y) => String(x.date).localeCompare(String(y.date))).forEach(i => {
    const r = el('button', { class: 'row rowbtn' });
    r.innerHTML = `<div class="main"><div class="t">${esc(i.source)} ${i.received ? '<span class="badge b-ok">received</span>' : '<span class="badge b-mut">expected</span>'}</div>
      <div class="s">${fmtD(i.date)} · ${recLabel(i.recurrence)}${i.account_id ? ' · ' + esc(acctName(i.account_id)) : ''}</div></div>
      <div class="amt pos">${money(i.amount)}</div><span class="chev">›</span>`;
    r.onclick = () => editIncome(i);
    c.appendChild(r);
  });
  txIn.forEach(t => {
    const r = el('button', { class: 'row rowbtn' });
    r.innerHTML = `<div class="main"><div class="t">${esc(t.description || 'Income')}</div>
      <div class="s">${fmtD(t.date)} · quick add</div></div><div class="amt pos">${money(t.amount)}</div><span class="chev">›</span>`;
    r.onclick = () => editTransaction(t);
    c.appendChild(r);
  });
  app.appendChild(c);

  const recurring = D.income.filter(i => i.recurrence && i.recurrence !== 'once');
  if (recurring.length) {
    const rc = sectionCard('Recurring income', null);
    recurring.forEach(i => {
      const r = el('button', { class: 'row rowbtn' });
      r.innerHTML = `<div class="main"><div class="t">${esc(i.source)}</div><div class="s">${recLabel(i.recurrence)} · started ${fmtD(i.date)}</div></div>
        <div class="amt">${money(i.amount)}</div><span class="chev">›</span>`;
      r.onclick = () => editIncome(i);
      rc.appendChild(r);
    });
    app.appendChild(rc);
  }
}

/* =====================================================================
   VIEW: Savings goals
   ===================================================================== */
function viewSavings(app) {
  const goals = D.savings_goals.filter(g => !g.archived).sort((a, b) => (a.sort_order - b.sort_order));
  const saved = goals.reduce((s, g) => s + num(g.current_amount), 0);
  const target = goals.reduce((s, g) => s + num(g.target_amount), 0);
  const tiles = el('div', { class: 'tiles' });
  const t1 = el('div', { class: 'tile' }); t1.innerHTML = `<div class="lab">Saved toward goals</div><div class="val tnum pos">${money0(saved)}</div>`;
  const t2 = el('div', { class: 'tile' }); t2.innerHTML = `<div class="lab">Total targets</div><div class="val tnum">${money0(target)}</div><div class="note">${target > 0 ? Math.round(saved / target * 100) : 0}% of the way</div>`;
  tiles.append(t1, t2); app.appendChild(tiles);

  const c = sectionCard('Goals', '+ New goal', () => editGoal(null));
  if (!goals.length) c.appendChild(emptyNote('No savings goals yet. Add one to start tracking.'));
  goals.forEach(g => {
    const cur = num(g.current_amount), tgt = num(g.target_amount);
    const pct = tgt > 0 ? Math.min(1, cur / tgt) : 0;
    let note = '';
    if (g.target_date && tgt > cur) {
      const months = Math.max(0, (parseD(g.target_date).getFullYear() - today().getFullYear()) * 12 + (parseD(g.target_date).getMonth() - today().getMonth()));
      note = months > 0 ? `${money0((tgt - cur) / months)}/mo to hit ${fmtD(g.target_date, { month: 'short', year: 'numeric' })}` : `target date ${fmtD(g.target_date, { month: 'short', year: 'numeric' })}`;
    } else if (cur >= tgt && tgt > 0) note = 'Goal reached 🎉';
    const w = el('div', { style: 'padding:12px 4px;border-bottom:1px solid var(--line)' });
    w.innerHTML = `<div style="display:flex;gap:8px;align-items:baseline;margin-bottom:6px">
        <div style="flex:1;font-weight:580;font-size:15px">${esc(g.name)}</div>
        <div class="tnum" style="font-weight:640;font-size:14px">${money0(cur)} <span style="color:var(--muted);font-weight:500">/ ${money0(tgt)}</span></div></div>
      <div class="bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:var(--muted)">
        <span>${Math.round(pct * 100)}% ${g.linked_account_id ? '· ' + esc(acctName(g.linked_account_id)) : ''}</span><span>${esc(note)}</span></div>`;
    const row = el('div', { class: 'btnrow', style: 'margin-top:9px' });
    const add = el('button', { class: 'btn sm olive' }, '+ Add money');
    add.onclick = e => { e.stopPropagation(); goalAdd(g); };
    const ed = el('button', { class: 'btn sm ghost' }, 'Edit');
    ed.onclick = e => { e.stopPropagation(); editGoal(g); };
    row.append(add, ed); w.appendChild(row);
    c.appendChild(w);
  });
  app.appendChild(c);
}
function goalAdd(g) {
  openSheet('Add to ' + g.name, b => {
    const amt = field(b, 'Amount to add', money_(''));
    b._get = () => ({ amount: num(amt.value) });
    setTimeout(() => amt.focus(), 250);
  }, [
    { label: 'Cancel', cls: 'ghost', onClick: closeSheet },
    {
      label: 'Add', cls: 'pri', onClick: async () => {
        const v = sheetGet(); closeSheet();
        if (v.amount <= 0) return toast('Enter an amount');
        await save('savings_goals', { ...g, current_amount: num(g.current_amount) + v.amount }, { msg: `Added ${money(v.amount)}` });
      }
    }
  ]);
}

/* =====================================================================
   VIEW: Sinking funds
   ===================================================================== */
function viewFunds(app) {
  const funds = D.sinking_funds.filter(f => !f.archived).sort((a, b) => (a.sort_order - b.sort_order));
  const bal = funds.reduce((s, f) => s + num(f.current_balance), 0);
  const mo = funds.reduce((s, f) => s + num(f.monthly_contribution), 0);
  const tiles = el('div', { class: 'tiles' });
  const t1 = el('div', { class: 'tile' }); t1.innerHTML = `<div class="lab">Set aside</div><div class="val tnum pos">${money0(bal)}</div><div class="note">${funds.length} funds</div>`;
  const t2 = el('div', { class: 'tile' }); t2.innerHTML = `<div class="lab">Monthly contributions</div><div class="val tnum">${money0(mo)}</div>`;
  tiles.append(t1, t2); app.appendChild(tiles);

  const due = fundsDueContribution(S.month);
  if (due.length) {
    const p = el('div', { class: 'card', style: 'border-color:var(--accent);background:var(--accent-soft)' });
    p.innerHTML = `<div class="sub">${due.length} fund${due.length > 1 ? 's' : ''} still need ${fmtMonth(S.month)}'s contribution.</div>`;
    const b = el('button', { class: 'btn pri wide', style: 'margin-top:10px' }, `Add ${money(due.reduce((s, f) => s + num(f.monthly_contribution), 0))}`);
    b.onclick = () => contributeFunds(S.month);
    p.appendChild(b); app.appendChild(p);
  }

  const c = sectionCard('Sinking funds', '+ New fund', () => editFund(null));
  c.appendChild(el('div', { class: 'sub', style: 'margin-bottom:8px' }, 'Buckets for known, irregular expenses — money set aside monthly so the bill never surprises you.'));
  if (!funds.length) c.appendChild(emptyNote('No sinking funds yet.'));
  funds.forEach(f => {
    const cur = num(f.current_balance), tgt = num(f.target_amount);
    const pct = tgt > 0 ? Math.min(1, cur / tgt) : 0;
    const w = el('div', { style: 'padding:12px 4px;border-bottom:1px solid var(--line)' });
    w.innerHTML = `<div style="display:flex;gap:8px;align-items:baseline;margin-bottom:6px">
        <div style="flex:1;font-weight:580;font-size:15px">${esc(f.name)}</div>
        <div class="tnum" style="font-weight:640;font-size:14px">${money0(cur)}${tgt > 0 ? ` <span style="color:var(--muted);font-weight:500">/ ${money0(tgt)}</span>` : ''}</div></div>
      ${tgt > 0 ? `<div class="bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>` : ''}
      <div style="margin-top:6px;font-size:12px;color:var(--muted)">${num(f.monthly_contribution) > 0 ? money0(f.monthly_contribution) + '/mo' : 'no monthly contribution set'}${f.last_contribution_month ? ' · last added ' + fmtD(f.last_contribution_month, { month: 'short', year: 'numeric' }) : ''}</div>`;
    const row = el('div', { class: 'btnrow', style: 'margin-top:9px' });
    const add = el('button', { class: 'btn sm olive' }, '+ Add');
    add.onclick = () => fundMove(f, 'contribution');
    const spend = el('button', { class: 'btn sm' }, '− Spend');
    spend.onclick = () => fundMove(f, 'withdrawal');
    const ed = el('button', { class: 'btn sm ghost' }, 'Edit');
    ed.onclick = () => editFund(f);
    row.append(add, spend, ed); w.appendChild(row);
    c.appendChild(w);
  });
  app.appendChild(c);

  const recent = D.sinking_fund_entries.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 25);
  if (recent.length) {
    const rc = sectionCard('Recent activity', null);
    recent.forEach(e => {
      const f = D.sinking_funds.find(x => x.id === e.fund_id);
      const r = el('div', { class: 'row' });
      r.innerHTML = `<div class="main"><div class="t">${esc(f ? f.name : 'Fund')}</div>
        <div class="s">${fmtD(e.date)}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
        <div class="amt ${e.kind === 'contribution' ? 'pos' : 'neg'}">${e.kind === 'contribution' ? '+' : '−'}${money(e.amount)}</div>`;
      rc.appendChild(r);
    });
    app.appendChild(rc);
  }
}

/* =====================================================================
   VIEW: Net worth
   ===================================================================== */
async function takeSnapshot() {
  const nw = netWorthNow();
  const row = { snapshot_date: iso(today()), total_assets: nw.assets, total_liabilities: nw.liab };
  const { data, error } = await sb.from('net_worth_snapshots').upsert(row, { onConflict: 'snapshot_date' }).select();
  if (error) { toast('Snapshot failed: ' + error.message, 3600); return; }
  const rec = data[0];
  const i = D.net_worth_snapshots.findIndex(x => x.id === rec.id);
  if (i >= 0) D.net_worth_snapshots[i] = rec; else D.net_worth_snapshots.push(rec);
  toast(`Snapshot saved — ${money0(nw.net)}`);
  render();
}

function viewNetWorth(app) {
  const nw = netWorthNow();
  const snaps = D.net_worth_snapshots.slice().sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
  const tiles = el('div', { class: 'tiles' });
  const t1 = el('div', { class: 'tile' });
  t1.innerHTML = `<div class="lab">Net worth today</div><div class="val tnum ${nw.net >= 0 ? 'pos' : 'neg'}">${money0(nw.net)}</div>`;
  const prev = snaps.length ? snaps[snaps.length - 1] : null;
  const change = prev ? nw.net - (num(prev.total_assets) - num(prev.total_liabilities)) : null;
  const t2 = el('div', { class: 'tile' });
  t2.innerHTML = `<div class="lab">Since last snapshot</div><div class="val tnum ${change == null ? '' : change >= 0 ? 'pos' : 'neg'}">${change == null ? '—' : (change >= 0 ? '+' : '−') + money0(Math.abs(change))}</div>
    <div class="note">${prev ? fmtD(prev.snapshot_date, { month: 'short', day: 'numeric', year: 'numeric' }) : 'no snapshots yet'}</div>`;
  tiles.append(t1, t2); app.appendChild(tiles);

  const c = sectionCard('Trend', 'Snapshot now', takeSnapshot);
  const wrap = el('div', { class: 'chartwrap' });
  c.appendChild(wrap);
  if (snaps.length >= 2) {
    c.appendChild(el('div', { class: 'legend' }, `<span class="k"><i style="background:${cssv('--s1')}"></i>Net worth</span>`));
  }
  app.appendChild(c);
  setTimeout(() => {
    if (snaps.length >= 2) {
      lineChart(wrap, snaps.map(s => ({
        label: fmtD(s.snapshot_date, { month: 'short', day: 'numeric' }),
        value: num(s.total_assets) - num(s.total_liabilities),
        extra: `<div class="tr"><span>Assets</span><span class="tnum">${money0(s.total_assets)}</span></div><div class="tr"><span>Debt</span><span class="tnum">${money0(s.total_liabilities)}</span></div>`
      })), { id: 'nwfull', height: 210, seriesName: 'Net worth', aria: 'Net worth over time', color: '--s1' });
    } else {
      wrap.innerHTML = '';
      wrap.appendChild(emptyNote('Take at least two snapshots to see a trend line.'));
    }
  }, 0);

  const hc = sectionCard('Snapshot history', null);
  if (!snaps.length) hc.appendChild(emptyNote('No snapshots yet. Reconcile your balances, then hit "Snapshot now".'));
  snaps.slice().reverse().forEach(s => {
    const net = num(s.total_assets) - num(s.total_liabilities);
    const r = el('div', { class: 'row' });
    r.innerHTML = `<div class="main"><div class="t">${fmtD(s.snapshot_date, { month: 'long', day: 'numeric', year: 'numeric' })}</div>
      <div class="s">${money0(s.total_assets)} assets · ${money0(s.total_liabilities)} debt</div></div>
      <div class="amt ${net >= 0 ? 'pos' : 'neg'}">${money0(net)}</div>`;
    const d = el('button', { class: 'iconbtn', style: 'width:32px;height:32px;font-size:14px' }, '🗑');
    d.onclick = () => confirmDelete('snapshot', () => remove('net_worth_snapshots', s.id));
    r.appendChild(d);
    hc.appendChild(r);
  });
  app.appendChild(hc);
}

/* =====================================================================
   VIEW: Spending trends
   ===================================================================== */
function spendingByMonth(nMonths) {
  const months = [];
  for (let i = nMonths - 1; i >= 0; i--) {
    const m = addMonths(monthStart(today()), -i);
    months.push({ d: m, key: monthKey(m), label: fmtMonthShort(m) });
  }
  const totals = new Map(); // catId -> total across window
  const grid = new Map();   // catId -> [per month]
  cats().forEach(c => { grid.set(c.id, months.map(() => 0)); totals.set(c.id, 0); });
  grid.set('__none', months.map(() => 0)); totals.set('__none', 0);

  months.forEach((m, i) => {
    const a = monthStart(m.d), z = monthEnd(m.d);
    D.transactions.forEach(t => {
      if (t.kind !== 'expense') return;
      const d = parseD(t.date); if (d < a || d > z) return;
      const k = grid.has(t.category_id) ? t.category_id : '__none';
      grid.get(k)[i] += num(t.amount); totals.set(k, totals.get(k) + num(t.amount));
    });
    D.bill_payments.forEach(p => {
      if (!p.paid) return;
      const bill = D.bills.find(x => x.id === p.bill_id); if (!bill) return;
      const d = parseD(p.paid_date || p.cycle_date); if (d < a || d > z) return;
      const amt = num(p.paid_amount != null ? p.paid_amount : bill.amount);
      const k = grid.has(bill.category_id) ? bill.category_id : '__none';
      grid.get(k)[i] += amt; totals.set(k, totals.get(k) + amt);
    });
  });
  const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return { months, grid, ranked };
}

function viewTrends(app) {
  const N = S.trendMonths || 6;
  const { months, grid, ranked } = spendingByMonth(N);
  const monthTotalsArr = months.map((_, i) => ranked.reduce((s, [k]) => s + grid.get(k)[i], 0));
  const nonZero = monthTotalsArr.filter(v => v > 0);
  const avg = nonZero.length ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length : 0;

  const tiles = el('div', { class: 'tiles' });
  const t1 = el('div', { class: 'tile' });
  t1.innerHTML = `<div class="lab">This month so far</div><div class="val tnum">${money0(monthTotalsArr[months.length - 1] || 0)}</div>`;
  const t2 = el('div', { class: 'tile' });
  t2.innerHTML = `<div class="lab">${N}-month average</div><div class="val tnum">${money0(avg)}</div><div class="note">per month</div>`;
  tiles.append(t1, t2); app.appendChild(tiles);

  const rangeCard = el('div', { class: 'card' });
  const seg = el('div', { class: 'seg' });
  [3, 6, 12].forEach(n => {
    const b = el('button', { 'aria-selected': String(N === n) }, `${n} months`);
    b.onclick = () => { S.trendMonths = n; render(); };
    seg.appendChild(b);
  });
  rangeCard.appendChild(seg);
  app.appendChild(rangeCard);

  const top = ranked.slice(0, 5);
  const rest = ranked.slice(5);
  const series = top.map(([k], i) => ({
    name: k === '__none' ? 'Uncategorized' : catName(k),
    color: cssv(SERIES[i]),
    values: grid.get(k)
  }));
  if (rest.length) {
    series.push({
      name: `Other (${rest.length})`, color: cssv(SERIES[5]),
      values: months.map((_, i) => rest.reduce((s, [k]) => s + grid.get(k)[i], 0))
    });
  }

  const c = sectionCard('Where the money goes', S.trendMode === 'chart' ? 'Table view' : 'Chart view',
    () => { S.trendMode = S.trendMode === 'chart' ? 'table' : 'chart'; render(); });
  if (!ranked.length) {
    c.appendChild(emptyNote('Nothing logged yet. Mark bills paid and use Quick Add — trends fill in from there.'));
  } else if (S.trendMode === 'chart') {
    const wrap = el('div', { class: 'chartwrap' });
    c.appendChild(wrap);
    const leg = el('div', { class: 'legend' });
    leg.innerHTML = series.map(s => `<span class="k"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
    c.appendChild(leg);
    setTimeout(() => stackedBarChart(wrap, months, series, { aria: 'Spending by category, month over month' }), 0);
  } else {
    const tbl = el('table', { class: 'tbl' });
    tbl.innerHTML = `<thead><tr><th>Category</th>${months.map(m => `<th>${esc(m.label)}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${ranked.map(([k, tot]) => `<tr><td>${esc(k === '__none' ? 'Uncategorized' : catName(k))}</td>
        ${grid.get(k).map(v => `<td class="tnum">${v ? money0(v) : '—'}</td>`).join('')}
        <td class="tnum"><b>${money0(tot)}</b></td></tr>`).join('')}
        <tr><td><b>Total</b></td>${monthTotalsArr.map(v => `<td class="tnum"><b>${money0(v)}</b></td>`).join('')}<td class="tnum"><b>${money0(monthTotalsArr.reduce((a, b) => a + b, 0))}</b></td></tr>
      </tbody>`;
    c.appendChild(tbl);
  }
  app.appendChild(c);

  /* month-over-month movers */
  if (months.length >= 2 && ranked.length) {
    const i = months.length - 1, j = months.length - 2;
    const movers = ranked.map(([k]) => ({
      name: k === '__none' ? 'Uncategorized' : catName(k),
      now: grid.get(k)[i], prev: grid.get(k)[j], diff: grid.get(k)[i] - grid.get(k)[j]
    })).filter(m => Math.abs(m.diff) > 0.5).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 6);
    if (movers.length) {
      const mc = sectionCard(`${fmtMonthShort(months[i].d)} vs ${fmtMonthShort(months[j].d)}`, null);
      if (monthKey(months[i].d) === monthKey(today())) {
        mc.appendChild(el('div', { class: 'sub', style: 'margin:-4px 0 8px' },
          `${fmtMonthShort(months[i].d)} is still in progress — day ${today().getDate()} of ${monthEnd(today()).getDate()}.`));
      }
      movers.forEach(m => {
        const r = el('div', { class: 'row' });
        r.innerHTML = `<div class="main"><div class="t">${esc(m.name)}</div><div class="s">${money0(m.prev)} → ${money0(m.now)}</div></div>
          <div class="amt ${m.diff > 0 ? 'neg' : 'pos'}">${m.diff > 0 ? '+' : '−'}${money0(Math.abs(m.diff))}</div>`;
        mc.appendChild(r);
      });
      app.appendChild(mc);
    }
  }
}

/* =====================================================================
   VIEW: Weekly review
   ===================================================================== */
function viewReview(app) {
  const intro = el('div', { class: 'card' });
  intro.innerHTML = `<div style="font-weight:660;font-size:16px;margin-bottom:3px">Weekly review</div>
    <div class="sub">Five minutes, once a week, together. Work top to bottom.</div>`;
  app.appendChild(intro);

  const step = (n, title, sub) => {
    const c = el('div', { class: 'card' });
    const h = el('div', { style: 'display:flex;gap:9px;align-items:center;margin-bottom:9px' });
    h.appendChild(el('div', { class: 'stepnum' }, String(n)));
    const t = el('div', {});
    t.innerHTML = `<div style="font-weight:620;font-size:15px">${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
    h.appendChild(t); c.appendChild(h);
    return c;
  };

  /* 1. reconcile balances */
  const s1 = step(1, 'Reconcile account balances', 'Open your bank app and type in what each account actually says.');
  const inputs = [];
  accts().forEach(a => {
    const r = el('div', { class: 'row' });
    const left = el('div', { class: 'main' });
    left.innerHTML = `<div class="t">${esc(a.name)}</div><div class="s">${esc(typeLabel(a.type))}${isDebt(a) ? ' · amount owed' : ''}</div>`;
    const i = el('input', { type: 'number', step: '0.01', inputmode: 'decimal', style: 'width:120px;text-align:right;padding:8px 10px' });
    i.value = num(a.balance);
    inputs.push({ a, i });
    r.append(left, i);
    s1.appendChild(r);
  });
  if (!accts().length) s1.appendChild(emptyNote('No accounts yet.'));
  else {
    const b = el('button', { class: 'btn pri wide', style: 'margin-top:12px' }, 'Save balances');
    b.onclick = async () => {
      let n = 0;
      for (const { a, i } of inputs) {
        const v = num(i.value);
        if (Math.abs(v - num(a.balance)) > 0.004) { await save('accounts', { ...a, balance: v, updated_at: new Date().toISOString() }, { silent: true }); n++; }
      }
      toast(n ? `Updated ${n} balance${n > 1 ? 's' : ''}` : 'No changes');
      render();
    };
    s1.appendChild(b);
  }
  app.appendChild(s1);

  /* 2. bills */
  const win = billInstances(addDays(today(), -60), addDays(today(), 7));
  const open = win.filter(x => !x.paid);
  const s2 = step(2, 'Clear this week\'s bills', 'Anything overdue or due in the next 7 days.');
  if (!open.length) s2.appendChild(emptyNote('All caught up — nothing outstanding.'));
  else open.forEach(x => s2.appendChild(billRow(x)));
  app.appendChild(s2);

  /* 3. income */
  const a0 = addDays(today(), -14);
  const expected = D.income.filter(i => !i.received && parseD(i.date) <= today() && parseD(i.date) >= addDays(today(), -45));
  const s3 = step(3, 'Confirm income received', 'Paychecks and any one-off money that landed.');
  if (!expected.length) s3.appendChild(emptyNote('Nothing outstanding.'));
  expected.forEach(i => {
    const r = el('div', { class: 'row' });
    r.innerHTML = `<div class="main"><div class="t">${esc(i.source)}</div><div class="s">${fmtD(i.date)}</div></div><div class="amt">${money(i.amount)}</div>`;
    const b = el('button', { class: 'btn sm olive' }, 'Received');
    b.onclick = () => save('income', { ...i, received: true }, { msg: 'Marked received' });
    r.appendChild(b); s3.appendChild(r);
  });
  app.appendChild(s3);

  /* 4. sinking funds */
  const due = fundsDueContribution(S.month);
  const s4 = step(4, 'Fund the sinking funds', 'Money set aside for the irregular stuff.');
  if (!due.length) s4.appendChild(emptyNote(`${fmtMonth(S.month)} contributions are already in.`));
  else {
    s4.appendChild(el('div', { class: 'sub' }, due.map(f => `${f.name} ${money0(f.monthly_contribution)}`).join(' · ')));
    const b = el('button', { class: 'btn pri wide', style: 'margin-top:11px' }, `Add ${money(due.reduce((s, f) => s + num(f.monthly_contribution), 0))} to ${due.length} fund${due.length > 1 ? 's' : ''}`);
    b.onclick = () => contributeFunds(S.month);
    s4.appendChild(b);
  }
  app.appendChild(s4);

  /* 5. budget check */
  const mt = monthTotals(S.month);
  const overs = mt.rows.filter(r => r.total > 0 && r.actual > r.total);
  const s5 = step(5, 'Check the budget', `${fmtMonth(S.month)} — ${money0(mt.actual)} of ${money0(mt.planned)} planned.`);
  if (!overs.length) s5.appendChild(el('div', { class: 'empty' }, 'No categories over budget. 👍'));
  else overs.forEach(r => {
    const row = el('div', { class: 'row' });
    row.innerHTML = `<div class="main"><div class="t">${esc(r.cat.name)}</div><div class="s">${money0(r.actual)} of ${money0(r.total)}</div></div>
      <div class="amt neg">${money0(r.actual - r.total)} over</div>`;
    s5.appendChild(row);
  });
  const bb = el('button', { class: 'btn wide ghost', style: 'margin-top:11px' }, 'Open full budget');
  bb.onclick = () => go('budget'); s5.appendChild(bb);
  app.appendChild(s5);

  /* 6. snapshot */
  const nw = netWorthNow();
  const s6 = step(6, 'Take a net worth snapshot', 'Locks in today\'s numbers so the trend line keeps growing.');
  s6.appendChild(el('div', { class: 'kv' }, `<span>Assets</span><b class="tnum">${money0(nw.assets)}</b>`));
  s6.appendChild(el('div', { class: 'kv' }, `<span>Debt</span><b class="tnum">${money0(nw.liab)}</b>`));
  s6.appendChild(el('div', { class: 'kv', style: 'border-top:1px solid var(--line);margin-top:4px;padding-top:8px' },
    `<span>Net worth</span><b class="tnum ${nw.net >= 0 ? 'pos' : 'neg'}" style="font-size:16px">${money0(nw.net)}</b>`));
  const sb6 = el('button', { class: 'btn olive wide', style: 'margin-top:12px' }, 'Save snapshot for today');
  sb6.onclick = takeSnapshot; s6.appendChild(sb6);
  app.appendChild(s6);

  const done = el('div', { class: 'card', style: 'text-align:center' });
  done.innerHTML = `<div style="font-size:15px;font-weight:620;margin-bottom:3px">That's the whole review.</div><div class="sub">Same time next week.</div>`;
  const db = el('button', { class: 'btn pri wide', style: 'margin-top:12px' }, 'Back to dashboard');
  db.onclick = () => go('dashboard'); done.appendChild(db);
  app.appendChild(done);
}

/* =====================================================================
   Export / import
   ===================================================================== */
function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}
function toCSV(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const q = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
}
function exportJSON() {
  const payload = {
    app: 'Household Budget Tracker', version: CFG.version,
    exported_at: new Date().toISOString(),
    data: Object.fromEntries(TABLES.map(t => [t, D[t]]))
  };
  download(`budget-backup-${iso(today())}.json`, JSON.stringify(payload, null, 2));
  toast('Backup downloaded');
}
function exportCSVs() {
  const parts = TABLES.filter(t => D[t].length).map(t => `### ${t}\n${toCSV(D[t])}`);
  download(`budget-export-${iso(today())}.csv`, parts.join('\n\n'), 'text/csv');
  toast('CSV downloaded');
}
function importJSON() {
  const f = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  document.body.appendChild(f);
  f.onchange = async () => {
    const file = f.files[0]; f.remove();
    if (!file) return;
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { return toast('That file is not valid JSON', 3200); }
    const d = parsed.data || parsed;
    const counts = TABLES.map(t => `${(d[t] || []).length} ${t}`).filter(s => !s.startsWith('0 ')).join(', ');
    if (!counts) return toast('Nothing recognizable in that file', 3200);
    openSheet('Restore from backup?', b => {
      b.appendChild(el('p', { class: 'sub' }, `This adds or overwrites records by ID: ${esc(counts)}. Existing records not in the file are left alone.`));
    }, [
      { label: 'Cancel', cls: 'ghost', onClick: closeSheet },
      {
        label: 'Restore', cls: 'pri', onClick: async () => {
          closeSheet(); toast('Restoring…', 6000);
          for (const t of TABLES) {
            const rows = d[t]; if (!rows || !rows.length) continue;
            const { error } = await sb.from(t).upsert(rows);
            if (error) { toast(`${t}: ${error.message}`, 4000); console.error(t, error); }
          }
          await loadAll(); reindexPayments(); render(); toast('Restore complete');
        }
      }
    ]);
  };
  f.click();
}

/* =====================================================================
   VIEW: More / settings
   ===================================================================== */
function viewMore(app) {
  const items = [
    ['income', '💵', 'Income', 'Paychecks and one-off money'],
    ['savings', '🎯', 'Savings goals', 'Named targets you\'re saving toward'],
    ['funds', '🪣', 'Sinking funds', 'Buckets for irregular expenses'],
    ['networth', '📈', 'Net worth', 'Snapshots and trend'],
    ['trends', '📊', 'Spending trends', 'Where the money actually goes'],
    ['review', '✅', 'Weekly review', 'The guided sit-down']
  ];
  const c = el('div', { class: 'card' });
  items.forEach(([v, ic, t, s]) => {
    const r = el('button', { class: 'row rowbtn' });
    r.innerHTML = `<div style="font-size:22px;width:32px;text-align:center">${ic}</div>
      <div class="main"><div class="t">${t}</div><div class="s">${s}</div></div><span class="chev">›</span>`;
    r.onclick = () => go(v);
    c.appendChild(r);
  });
  /* the manual — a plain page, not an app view */
  const help = el('a', { class: 'row rowbtn', href: 'manual.html', style: 'text-decoration:none;color:inherit' });
  help.innerHTML = `<div style="font-size:22px;width:32px;text-align:center">📖</div>
    <div class="main"><div class="t">How to use this app</div><div class="s">The manual — what every screen does</div></div><span class="chev">›</span>`;
  c.appendChild(help);
  app.appendChild(c);

  const bc = sectionCard('Backup & export', null);
  bc.appendChild(el('div', { class: 'sub', style: 'margin-bottom:11px' }, 'Your own copy of everything, independent of Supabase.'));
  const row = el('div', { class: 'btnrow' });
  const j = el('button', { class: 'btn pri' }, 'Export JSON'); j.onclick = exportJSON;
  const cs = el('button', { class: 'btn' }, 'Export CSV'); cs.onclick = exportCSVs;
  const im = el('button', { class: 'btn ghost' }, 'Restore backup'); im.onclick = importJSON;
  row.append(j, cs, im); bc.appendChild(row);
  const counts = el('div', { class: 'sub', style: 'margin-top:10px' },
    esc(`${D.accounts.length} accounts · ${D.bills.length} bills · ${D.transactions.length} transactions · ${D.bill_payments.length} payments · ${D.net_worth_snapshots.length} snapshots`));
  bc.appendChild(counts);
  app.appendChild(bc);

  const sc = sectionCard('Settings', null);
  const pw = el('button', { class: 'btn wide', style: 'margin-bottom:8px' }, 'Change household password');
  pw.onclick = changePassword;
  const th = el('button', { class: 'btn wide ghost', style: 'margin-bottom:8px' }, 'Toggle light / dark');
  th.onclick = toggleTheme;
  const out = el('button', { class: 'btn wide ghost dang' }, 'Sign out on this device');
  out.onclick = () => { localStorage.removeItem(LS_KEY); location.reload(); };
  sc.append(pw, th, out);
  sc.appendChild(el('div', { class: 'sub', style: 'margin-top:14px;text-align:center' },
    `Household Budget Tracker ${CFG.version} · synced live via Supabase`));
  app.appendChild(sc);
}

function changePassword() {
  openSheet('Change household password', b => {
    const cur = field(b, 'Current password', inp('password', '', { autocomplete: 'current-password' }));
    const n1 = field(b, 'New password', inp('password', '', { autocomplete: 'new-password' }));
    const n2 = field(b, 'Confirm new password', inp('password', '', { autocomplete: 'new-password' }));
    b.appendChild(el('div', { class: 'sub', style: 'margin-top:10px' }, 'Both of you use the same password — whoever changes it needs to tell the other.'));
    b._get = () => ({ cur: cur.value, n1: n1.value, n2: n2.value });
  }, [
    { label: 'Cancel', cls: 'ghost', onClick: closeSheet },
    {
      label: 'Change', cls: 'pri', onClick: async () => {
        const v = sheetGet();
        if (v.n1.length < 6) return toast('Use at least 6 characters');
        if (v.n1 !== v.n2) return toast('New passwords do not match');
        const curHash = await sha256(v.cur);
        const { data } = await sb.from('household_settings').select('*').eq('id', 1).single();
        if (!data || data.password_hash !== curHash) return toast('Current password is wrong');
        const newHash = await sha256(v.n1);
        const { error } = await sb.from('household_settings').update({ password_hash: newHash, updated_at: new Date().toISOString() }).eq('id', 1);
        if (error) return toast('Failed: ' + error.message, 3600);
        localStorage.setItem(LS_KEY, newHash);
        closeSheet(); toast('Password changed');
      }
    }
  ]);
}

/* =====================================================================
   Router / shell
   ===================================================================== */
const VIEWS = {
  dashboard: { title: 'Dashboard', fn: viewDashboard },
  bills: { title: 'Bills', fn: viewBills },
  budget: { title: 'Budget', fn: viewBudget },
  accounts: { title: 'Accounts', fn: viewAccounts },
  more: { title: 'More', fn: viewMore },
  income: { title: 'Income', fn: viewIncome },
  savings: { title: 'Savings Goals', fn: viewSavings },
  funds: { title: 'Sinking Funds', fn: viewFunds },
  networth: { title: 'Net Worth', fn: viewNetWorth },
  trends: { title: 'Spending Trends', fn: viewTrends },
  review: { title: 'Weekly Review', fn: viewReview }
};
const TABS = [
  ['dashboard', '🏠', 'Home'], ['bills', '🧾', 'Bills'], ['budget', '📋', 'Budget'],
  ['accounts', '🏦', 'Accounts'], ['more', '⋯', 'More']
];
const TAB_OF = { dashboard: 'dashboard', bills: 'bills', budget: 'budget', accounts: 'accounts', more: 'more', income: 'more', savings: 'more', funds: 'more', networth: 'more', trends: 'more', review: 'more' };

function go(v) {
  S.view = v;
  if (location.hash !== '#' + v) history.pushState({ v }, '', '#' + v);
  window.scrollTo(0, 0);
  render();
}
window.addEventListener('popstate', () => {
  const v = location.hash.replace('#', '') || 'dashboard';
  S.view = VIEWS[v] ? v : 'dashboard';
  render();
});

function buildTabs() {
  const nav = $('#tabs'); nav.innerHTML = '';
  TABS.forEach(([v, ic, l]) => {
    const b = el('button', { role: 'tab' });
    b.innerHTML = `<span class="ic">${ic}</span><span>${l}</span>`;
    b.onclick = () => go(v);
    b.dataset.v = v;
    nav.appendChild(b);
  });
}

function render() {
  if (!S.loaded) return;
  reindexPayments();
  const v = VIEWS[S.view] || VIEWS.dashboard;
  $('#viewTitle').textContent = v.title;
  const app = $('#app');
  app.innerHTML = '';
  try { v.fn(app); } catch (e) { console.error(e); app.appendChild(el('div', { class: 'card' }, `<b>Something went wrong rendering this screen.</b><div class="sub" style="margin-top:6px">${esc(e.message)}</div>`)); }
  $$('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.v === TAB_OF[S.view])));
  $('#fab').style.display = S.view === 'review' ? 'none' : 'grid';
}

/* theme */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('hbt_theme', t);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#141210' : '#8a4a1c');
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  render();
}
(() => {
  const saved = localStorage.getItem('hbt_theme');
  applyTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
})();

/* =====================================================================
   Boot
   ===================================================================== */
async function startApp() {
  $('#gate').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  buildTabs();
  try {
    await loadAll();
  } catch (e) {
    $('#app').innerHTML = `<div class="card"><b>Could not reach the database.</b><div class="sub" style="margin-top:6px">${esc(e.message || e)}</div></div>`;
    setSync(false, 'Offline');
    return;
  }
  reindexPayments();
  const v = location.hash.replace('#', '');
  if (VIEWS[v]) S.view = v;
  render();
  startRealtime();
  /* auto-roll leftovers into the current month once it turns over */
  try {
    const n = await applyRollovers(monthStart(today()));
    if (n) { render(); }
  } catch (e) { console.warn('rollover', e); }
}

$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('#gatePw').value;
  const err = $('#gateErr');
  const btn = $('#gateForm button[type=submit]');
  err.textContent = '';
  if (!pw) { err.textContent = 'Enter the household password'; return; }
  btn.disabled = true; btn.textContent = 'Checking…';
  const restore = () => { btn.disabled = false; btn.textContent = 'Unlock'; };
  try {
    const ok = await tryUnlock(pw, $('#gateRemember').checked);
    if (!ok) { err.textContent = 'That password is not right'; restore(); $('#gatePw').select(); return; }
    startApp();
  } catch (ex) {
    err.textContent = 'Could not reach the database — check your connection';
    restore();
    console.error(ex);
  }
});

$('#fab').addEventListener('click', quickAdd);
$('#themeBtn').addEventListener('click', toggleTheme);
$('#moreBtn').addEventListener('click', () => go('more'));

(async () => {
  if (await autoUnlock()) startApp();
  else setTimeout(() => $('#gatePw').focus(), 300);
})();

/* service worker */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
