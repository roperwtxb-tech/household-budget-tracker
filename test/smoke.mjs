import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899/index.html';
const PW = 'Reaganrose919';
const errors = [];
const shots = [];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });

/* The sandbox blocks egress to supabase.co, so swap in a PostgREST-shaped shim
   backed by localStorage (shared across tabs) + BroadcastChannel for realtime.
   Seeded with the exact rows that live in the real Supabase project today. */
import fs from 'fs';
const MOCK = fs.readFileSync('test/mock-supabase.js', 'utf8');
const SEED = fs.readFileSync('test/seed.json', 'utf8');
await ctx.addInitScript(`window.__MOCK_SEED__ = ${SEED};`);
// serve the shim in place of the real supabase-js bundle
await ctx.route('**/vendor/supabase.js', r => r.fulfill({ contentType: 'application/javascript', body: MOCK }));

const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

async function shot(name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `test/shots/${name}.png`, fullPage: true });
  shots.push(name);
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// gate
if (!(await page.locator('#gate').isVisible())) throw new Error('gate not visible');
await page.fill('#gatePw', 'wrongpassword');
await page.click('#gateForm button[type=submit]');
await page.waitForTimeout(1200);
const errText = await page.locator('#gateErr').textContent();
console.log('WRONG PW ->', JSON.stringify(errText));
if (!errText.trim()) throw new Error('wrong password was accepted silently');

await page.fill('#gatePw', PW);
await page.click('#gateForm button[type=submit]');
await page.waitForSelector('#shell:not(.hidden)', { timeout: 15000 });
await page.waitForTimeout(2500);
console.log('unlocked OK');
await shot('01-dashboard');

// counts pulled from Supabase
const counts = await page.evaluate(() => ({
  accounts: D.accounts.length, cats: D.budget_categories.length, funds: D.sinking_funds.length,
  sync: document.querySelector('#syncTxt').textContent
}));
console.log('LOADED:', JSON.stringify(counts));

// --- create data through the UI ---
// 1. edit an account balance
await page.click('#tabs button[data-v=accounts]');
await page.waitForTimeout(600);
await page.locator('.card .row').first().click();
await page.waitForTimeout(700);
await page.locator('#sheet input[type=number]').first().fill('4250.75');
await page.locator('#sheet .sheet-foot button:has-text("Save")').click();
await page.waitForTimeout(1400);
await shot('02-accounts');
const bal = await page.evaluate(() => D.accounts.map(a => a.balance).filter(b => Number(b) > 4000));
console.log('BALANCE WRITE:', JSON.stringify(bal));
if (!bal.length) throw new Error('account balance did not persist');

// 2. set a debt account with rate + payment to test payoff math
await page.evaluate(async () => {
  const cc = D.accounts.find(a => a.type === 'credit');
  await save('accounts', { ...cc, balance: 4800, interest_rate: 21.99, minimum_payment: 250 }, { silent: true });
  const loan = D.accounts.find(a => a.type === 'loan');
  await save('accounts', { ...loan, balance: 18500, interest_rate: 6.5, minimum_payment: 480 }, { silent: true });
  const sav = D.accounts.find(a => a.name === 'Household Savings');
  await save('accounts', { ...sav, balance: 9200 }, { silent: true });
});
await page.waitForTimeout(1500);
await shot('03-accounts-debt');
const payoff = await page.evaluate(() => {
  const cc = D.accounts.find(a => a.type === 'credit');
  return { months: payoffMonths(cc.balance, cc.interest_rate, cc.minimum_payment), never: payoffMonths(5000, 24, 50) };
});
console.log('PAYOFF MATH:', JSON.stringify(payoff));

// 3. add a bill via the UI
await page.click('#tabs button[data-v=bills]');
await page.waitForTimeout(600);
await page.locator('.card-h .link:has-text("New bill")').first().click();
await page.waitForTimeout(700);
await page.locator('#sheet input[type=text]').first().fill('Electric — Test');
await page.locator('#sheet input[type=number]').first().fill('184.20');
const d = new Date(); const anchor = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-05`;
await page.locator('#sheet input[type=date]').first().fill(anchor);
await page.locator('#sheet .sheet-foot button:has-text("Save")').click();
await page.waitForTimeout(1500);
await shot('04-bills');
const billCount = await page.evaluate(() => D.bills.length);
console.log('BILLS:', billCount);
if (!billCount) throw new Error('bill did not save');

// 4. mark it paid
await page.locator('button.btn.sm.olive:has-text("Pay")').first().click();
await page.waitForTimeout(1600);
const paid = await page.evaluate(() => D.bill_payments.filter(p => p.paid).length);
console.log('PAID PAYMENTS:', paid);
if (!paid) throw new Error('bill payment did not persist');
await shot('05-bills-paid');

// 5. quick add expense
await page.click('#fab');
await page.waitForTimeout(700);
await page.locator('#sheet input[type=number]').first().fill('96.42');
await page.locator('#sheet input[type=text]').first().fill('Groceries at HEB');
await page.locator('#sheet select').first().selectOption({ label: 'Groceries' });
await shot('06-quickadd');
await page.locator('#sheet .sheet-foot button:has-text("Add")').click();
await page.waitForTimeout(1500);
const tx = await page.evaluate(() => D.transactions.length);
console.log('TRANSACTIONS:', tx);
if (!tx) throw new Error('quick add did not persist');

// 6. budget with planned amounts + rollover
await page.evaluate(async () => {
  const g = D.budget_categories.find(c => c.name === 'Groceries');
  await save('budget_categories', { ...g, monthly_planned_amount: 800 }, { silent: true });
  const u = D.budget_categories.find(c => c.name === 'Utilities');
  await save('budget_categories', { ...u, monthly_planned_amount: 320 }, { silent: true });
  const h = D.budget_categories.find(c => c.name === 'Home Repairs');
  await save('budget_categories', { ...h, monthly_planned_amount: 150, rollover_enabled: true }, { silent: true });
});
await page.waitForTimeout(1200);
await page.click('#tabs button[data-v=budget]');
await page.waitForTimeout(900);
await shot('07-budget');

// rollover button
await page.locator('button:has-text("Roll leftovers in from")').click();
await page.waitForTimeout(1600);
const roll = await page.evaluate(() => D.budget_entries.map(e => ({ c: catName(e.category_id), m: e.month, r: e.rolled_over_amount })));
console.log('ROLLOVER ENTRIES:', JSON.stringify(roll));
await shot('08-budget-rollover');

// 7. income
await page.evaluate(async () => {
  const t = new Date(); const d1 = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`;
  await save('income', { source: 'Sean paycheck', amount: 3200, date: d1, recurrence: 'semimonthly', received: true }, { silent: true });
  await save('income', { source: 'Jessica paycheck', amount: 1850, date: d1, recurrence: 'monthly', received: false }, { silent: true });
});
await page.waitForTimeout(1200);
await page.evaluate(() => go('income'));
await page.waitForTimeout(800);
await shot('09-income');

// 8. savings goal
await page.evaluate(() => go('savings'));
await page.waitForTimeout(600);
await page.locator('.card-h .link:has-text("New goal")').click();
await page.waitForTimeout(700);
await page.locator('#sheet input[type=text]').first().fill('New Tractor');
const nums = page.locator('#sheet input[type=number]');
await nums.nth(0).fill('12000');
await nums.nth(1).fill('3400');
await page.locator('#sheet input[type=date]').first().fill(`${d.getFullYear() + 1}-06-01`);
await page.locator('#sheet .sheet-foot button:has-text("Save")').click();
await page.waitForTimeout(1500);
await shot('10-savings');
const goals = await page.evaluate(() => D.savings_goals.length);
console.log('GOALS:', goals);
if (!goals) throw new Error('goal did not save');

// 9. sinking funds — set contributions and apply
await page.evaluate(async () => {
  for (const [n, amt, tgt] of [['Car Repair', 75, 1500], ['Christmas', 150, 1800], ['Property Taxes', 320, 3840], ['Vet Bills', 50, 600], ['Home Maintenance', 100, 1200]]) {
    const f = D.sinking_funds.find(x => x.name === n);
    if (f) await save('sinking_funds', { ...f, monthly_contribution: amt, target_amount: tgt }, { silent: true });
  }
});
await page.waitForTimeout(1500);
await page.evaluate(() => go('funds'));
await page.waitForTimeout(800);
await shot('11-funds-before');
await page.locator('button.btn.pri:has-text("Add $")').first().click();
await page.waitForTimeout(3000);
const fundBal = await page.evaluate(() => D.sinking_funds.map(f => ({ n: f.name, b: f.current_balance, last: f.last_contribution_month })));
console.log('FUNDS AFTER CONTRIB:', JSON.stringify(fundBal));
await shot('12-funds-after');
// idempotency: prompt should be gone
const stillDue = await page.evaluate(() => fundsDueContribution(S.month).length);
console.log('FUNDS STILL DUE (want 0):', stillDue);
if (stillDue !== 0) throw new Error('sinking fund contributions not idempotent');

// 10. net worth snapshots (backdated so the trend has points)
await page.evaluate(async () => {
  const mk = (daysAgo, a, l) => {
    const t = new Date(); t.setDate(t.getDate() - daysAgo);
    return { snapshot_date: `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`, total_assets: a, total_liabilities: l };
  };
  const rows = [mk(150, 21000, 29500), mk(120, 22400, 28800), mk(90, 23100, 27900), mk(60, 24800, 26400), mk(30, 25900, 24800)];
  await sb.from('net_worth_snapshots').upsert(rows, { onConflict: 'snapshot_date' });
  await loadAll();
});
await page.waitForTimeout(1200);
await page.evaluate(() => go('networth'));
await page.waitForTimeout(900);
await page.locator('.card-h .link:has-text("Snapshot now")').click();
await page.waitForTimeout(1600);
await shot('13-networth');
const snaps = await page.evaluate(() => D.net_worth_snapshots.length);
console.log('SNAPSHOTS:', snaps);
if (snaps < 6) throw new Error('snapshot did not save');

// hover the line chart
const chartBox = await page.locator('#nwfull_wrap, .chartwrap').first().boundingBox();
if (chartBox) {
  await page.mouse.move(chartBox.x + chartBox.width * 0.6, chartBox.y + chartBox.height * 0.5);
  await page.waitForTimeout(400);
  const tipOn = await page.locator('.tip.on').count();
  console.log('LINE TOOLTIP VISIBLE:', tipOn);
}
await shot('14-networth-tooltip');

// 11. spending trends — backfill several months of transactions
await page.evaluate(async () => {
  const rows = [];
  const catByName = n => (D.budget_categories.find(c => c.name === n) || {}).id;
  const plan = [['Groceries', [720, 810, 690, 775, 840]], ['Fuel / Gas', [240, 265, 210, 288, 255]],
    ['Utilities', [310, 288, 340, 365, 302]], ['Dining Out', [180, 240, 155, 205, 190]],
    ['Ranch / Livestock', [420, 380, 510, 340, 460]], ['Kids / School', [95, 130, 88, 145, 110]],
    ['Insurance', [285, 285, 285, 285, 285]]];
  for (const [name, vals] of plan) {
    const cid = catByName(name); if (!cid) continue;
    vals.forEach((v, i) => {
      const t = new Date(); const m = new Date(t.getFullYear(), t.getMonth() - (5 - i), 12);
      rows.push({ date: `${m.getFullYear()}-${String(m.getMonth()+1).padStart(2,'0')}-12`, description: name + ' spend', amount: v, kind: 'expense', category_id: cid });
    });
  }
  await sb.from('transactions').insert(rows);
  await loadAll();
});
await page.waitForTimeout(1500);
await page.evaluate(() => go('trends'));
await page.waitForTimeout(1200);
await shot('15-trends');
const bars = await page.locator('.chartwrap svg rect').count();
console.log('TREND BARS DRAWN:', bars);
if (bars < 5) throw new Error('stacked bar chart did not render');

// bar tooltip
const bb = await page.locator('.chartwrap').first().boundingBox();
await page.mouse.move(bb.x + bb.width * 0.75, bb.y + bb.height * 0.6);
await page.waitForTimeout(400);
console.log('BAR TOOLTIP:', await page.locator('.tip.on').count());
await shot('16-trends-tooltip');

// table view
await page.locator('.card-h .link:has-text("Table view")').click();
await page.waitForTimeout(700);
await shot('17-trends-table');
const rowsN = await page.locator('.tbl tbody tr').count();
console.log('TABLE ROWS:', rowsN);
if (rowsN < 3) throw new Error('table view empty');

// 12. dashboard again with real data
await page.evaluate(() => go('dashboard'));
await page.waitForTimeout(1400);
await shot('18-dashboard-full');

// 13. weekly review
await page.evaluate(() => go('review'));
await page.waitForTimeout(1000);
await shot('19-review');
const steps = await page.locator('.stepnum').count();
console.log('REVIEW STEPS:', steps);
if (steps !== 6) throw new Error('weekly review steps missing');

// 14. more + export
await page.click('#tabs button[data-v=more]');
await page.waitForTimeout(700);
await shot('20-more');
const dl = page.waitForEvent('download', { timeout: 8000 });
await page.locator('button:has-text("Export JSON")').click();
const download = await dl;
console.log('EXPORT FILE:', download.suggestedFilename());
const p = await download.path();
const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('EXPORT TABLES:', Object.keys(parsed.data).length, 'accounts in export:', parsed.data.accounts.length);
if (parsed.data.accounts.length < 1) throw new Error('export empty');

// CSV export
const dl2 = page.waitForEvent('download', { timeout: 8000 });
await page.locator('button:has-text("Export CSV")').click();
const d2 = await dl2;
console.log('CSV FILE:', d2.suggestedFilename());

// 15. dark mode across key views
await page.click('#themeBtn');
await page.waitForTimeout(600);
await page.evaluate(() => go('dashboard'));
await page.waitForTimeout(1200);
await shot('21-dark-dashboard');
await page.evaluate(() => go('trends'));
await page.waitForTimeout(1200);
await shot('22-dark-trends');
await page.evaluate(() => go('budget'));
await page.waitForTimeout(900);
await shot('23-dark-budget');
await page.click('#themeBtn');
await page.waitForTimeout(500);

// 16. second device sees the same data (live sync)
const page2 = await ctx.newPage();
page2.on('pageerror', e => errors.push('P2 PAGEERROR: ' + e.message));
await page2.goto(BASE, { waitUntil: 'networkidle' });
await page2.waitForTimeout(2500);
const auto = await page2.locator('#shell').isVisible();
console.log('DEVICE 2 AUTO-UNLOCK:', auto);
const p2counts = await page2.evaluate(() => ({ accounts: D.accounts.length, tx: D.transactions.length, goals: D.savings_goals.length }));
console.log('DEVICE 2 DATA:', JSON.stringify(p2counts));

// live push: change on page1, see it on page2
await page.evaluate(async () => {
  const g = D.savings_goals.find(x => x.name === 'New Tractor');
  await save('savings_goals', { ...g, current_amount: 5555 }, { silent: true });
});
await page2.waitForTimeout(3500);
const live = await page2.evaluate(() => (D.savings_goals.find(x => x.name === 'New Tractor') || {}).current_amount);
console.log('LIVE SYNC VALUE ON DEVICE 2 (want 5555):', live);
if (Number(live) !== 5555) errors.push('LIVE SYNC did not propagate (got ' + live + ')');

// 17. desktop width render
const wide = await ctx.newPage();
await wide.setViewportSize({ width: 1280, height: 900 });
await wide.goto(BASE, { waitUntil: 'networkidle' });
await wide.waitForTimeout(2500);
await wide.screenshot({ path: 'test/shots/24-desktop.png', fullPage: false });
shots.push('24-desktop');

console.log('\n=== ERRORS ===');
console.log(errors.length ? errors.join('\n') : 'none');
console.log('=== SHOTS ===', shots.length);
await browser.close();
if (errors.length) process.exit(1);
