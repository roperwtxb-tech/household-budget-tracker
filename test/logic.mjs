/* Unit tests for the date/budget/debt math, run inside the page so they use the real code. */
import { chromium } from 'playwright';
import fs from 'fs';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext();
await ctx.addInitScript(`window.__MOCK_SEED__ = ${fs.readFileSync('test/seed.json', 'utf8')};`);
await ctx.route('**/vendor/supabase.js', r => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('test/mock-supabase.js', 'utf8') }));
const page = await ctx.newPage();
const fails = [];
page.on('pageerror', e => fails.push('PAGEERROR ' + e.message));
await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('hbt_auth_v1', '35d05813a0619bc2c853cddcb1c9d7848b2a5ce4800e2d3328181c9176711a3b'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#shell:not(.hidden)');
await page.waitForTimeout(1200);

const results = await page.evaluate(() => {
  const out = [];
  const eq = (name, got, want) => out.push({ name, got: JSON.stringify(got), want: JSON.stringify(want), ok: JSON.stringify(got) === JSON.stringify(want) });

  /* ---- recurrence engine ---- */
  const B = (due, rec) => ({ id: 'x', due_date: due, recurrence: rec, archived: false });
  eq('monthly across a quarter',
    occurrences(B('2026-01-15', 'monthly'), parseD('2026-01-01'), parseD('2026-03-31')),
    ['2026-01-15', '2026-02-15', '2026-03-15']);
  eq('monthly clamps to short February',
    occurrences(B('2026-01-31', 'monthly'), parseD('2026-02-01'), parseD('2026-02-28')),
    ['2026-02-28']);
  eq('weekly',
    occurrences(B('2026-08-03', 'weekly'), parseD('2026-08-01'), parseD('2026-08-31')),
    ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31']);
  eq('biweekly',
    occurrences(B('2026-08-07', 'biweekly'), parseD('2026-08-01'), parseD('2026-09-15')),
    ['2026-08-07', '2026-08-21', '2026-09-04']);
  eq('semimonthly',
    occurrences(B('2026-08-01', 'semimonthly'), parseD('2026-08-01'), parseD('2026-09-30')),
    ['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-15']);
  eq('quarterly',
    occurrences(B('2026-02-10', 'quarterly'), parseD('2026-01-01'), parseD('2026-12-31')),
    ['2026-02-10', '2026-05-10', '2026-08-10', '2026-11-10']);
  eq('annual',
    occurrences(B('2025-11-20', 'annual'), parseD('2026-01-01'), parseD('2027-12-31')),
    ['2026-11-20', '2027-11-20']);
  eq('one-time inside window', occurrences(B('2026-08-09', 'once'), parseD('2026-08-01'), parseD('2026-08-31')), ['2026-08-09']);
  eq('one-time outside window', occurrences(B('2026-07-09', 'once'), parseD('2026-08-01'), parseD('2026-08-31')), []);
  eq('never emits before the anchor', occurrences(B('2026-06-05', 'monthly'), parseD('2026-01-01'), parseD('2026-07-31')),
    ['2026-06-05', '2026-07-05']);

  /* ---- debt payoff ---- */
  eq('payoff: 0% interest', payoffMonths(1200, 0, 100), 12);
  eq('payoff: zero balance', payoffMonths(0, 20, 100), 0);
  eq('payoff: no payment', payoffMonths(1000, 20, 0), null);
  eq('payoff: payment below interest -> never', payoffMonths(5000, 24, 50), null);
  // $4,800 at 21.99% paying $250 -> 24 months (checked against amortization below)
  eq('payoff: standard amortization', payoffMonths(4800, 21.99, 250), 24);
  // brute-force cross-check
  const brute = (b, apr, p) => { let bal = b, m = 0; const r = apr / 100 / 12; while (bal > 0 && m < 1000) { bal = bal * (1 + r) - p; m++; } return m; };
  eq('payoff matches brute-force sim', payoffMonths(4800, 21.99, 250), brute(4800, 21.99, 250));
  eq('payoff matches brute-force sim 2', payoffMonths(18500, 6.5, 480), brute(18500, 6.5, 480));

  /* ---- money formatting ---- */
  eq('money', money(1234.5), '$1,234.50');
  eq('money0 rounds', money0(1234.56), '$1,235');
  eq('negative money', money(-42), '-$42.00');

  /* ---- date safety (no timezone drift) ---- */
  eq('parse/iso round trip', iso(parseD('2026-03-01')), '2026-03-01');
  eq('monthKey', monthKey(parseD('2026-03-17')), '2026-03-01');
  eq('monthEnd of Feb 2028 (leap)', iso(monthEnd(parseD('2028-02-05'))), '2028-02-29');
  eq('addMonths clamps', iso(addMonths(parseD('2026-01-31'), 1)), '2026-02-28');

  return out;
});

/* ---- rollover behaviour (needs writes) ---- */
const rollover = await page.evaluate(async () => {
  const cat = D.budget_categories.find(c => c.name === 'Home Repairs');
  await save('budget_categories', { ...cat, monthly_planned_amount: 200, rollover_enabled: true }, { silent: true });
  const prev = addMonths(monthStart(today()), -1);
  const cur = monthStart(today());
  // spend $50 of last month's $200
  await save('transactions', { date: `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-10`, description: 'test', amount: 50, kind: 'expense', category_id: cat.id }, { silent: true });
  // clear any entry for the current month so the roll is recomputed
  const existing = entryFor(cat.id, cur);
  if (existing) await remove('budget_entries', existing.id);
  await applyRollovers(cur);
  const e = entryFor(cat.id, cur);
  const p = plannedFor(D.budget_categories.find(c => c.id === cat.id), cur);
  return { prevActual: actualFor(cat.id, prev), rolled: Number(e && e.rolled_over_amount), planned: p };
});

const nonRoll = await page.evaluate(async () => {
  const cat = D.budget_categories.find(c => c.name === 'Groceries'); // rollover off
  const cur = monthStart(today());
  const e = entryFor(cat.id, cur);
  return { rolloverEnabled: cat.rollover_enabled, hasEntry: !!e };
});

console.log('--- logic tests ---');
results.forEach(r => { console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : `\n        got  ${r.got}\n        want ${r.want}`)); if (!r.ok) fails.push(r.name); });
console.log('\n--- rollover ---');
console.log('prev month actual (want 50):', rollover.prevActual);
console.log('rolled into this month (want 150):', rollover.rolled);
console.log('planned this month (want base 200 + roll 150 = 350):', JSON.stringify(rollover.planned));
if (Number(rollover.prevActual) !== 50) fails.push('prev actual');
if (Number(rollover.rolled) !== 150) fails.push('rollover amount');
if (Number(rollover.planned.total) !== 350) fails.push('planned total with rollover');
console.log('non-rollover category untouched (want rolloverEnabled=false):', JSON.stringify(nonRoll));
if (nonRoll.rolloverEnabled) fails.push('groceries should not roll over');

console.log('\n=== ' + (fails.length ? 'FAILURES: ' + fails.join(', ') : 'ALL LOGIC TESTS PASS') + ' ===');
await browser.close();
if (fails.length) process.exit(1);
