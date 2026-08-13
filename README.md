# Household Budget Tracker

A shared budget app for Sean & Jessica. Installable PWA, mobile-first, backed by
Supabase so both phones see the same numbers live — change something on one
phone and it appears on the other in about a second.

**Household password:** `Reaganrose919` — change it any time under
**More → Settings → Change household password**.

---

## Deploying to GitHub Pages

Nothing to build. It's static files — push them and turn Pages on.

```bash
# from the unzipped folder
cd household-budget-tracker

git init
git add .
git commit -m "Household Budget Tracker"
git branch -M main
git remote add origin https://github.com/roperwtxb-tech/household-budget-tracker.git
git push -u origin main
```

Create the repo first at <https://github.com/new> under the **roperwtxb-tech**
account, named `household-budget-tracker`, empty (no README, no .gitignore).

Then: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
branch `main`, folder `/ (root)`. Save. It goes live in a minute or two at:

```
https://roperwtxb-tech.github.io/household-budget-tracker/
```

### Installing it on your phones

Open that URL on each phone.

- **iPhone (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** ⋮ menu → *Install app* / *Add to Home screen*

It then opens full-screen like a real app. Enter the household password once on
each phone and tick *Stay signed in on this device* — you won't be asked again.

### Pushing an update later

```bash
git add . && git commit -m "tweak" && git push
```

The service worker caches the app shell, so after an update you may need to close
and reopen the app once (or pull-to-refresh in the browser) to pick it up.

---

## How it's wired

| Piece | Detail |
|---|---|
| Frontend | Plain HTML/CSS/JS — no build step, no framework |
| Backend | Supabase project **roped-in-ranch** (`hrtuhexblsbdjfdbfblg`), 11 new tables |
| Sync | Supabase Realtime — every table is in the `supabase_realtime` publication |
| Auth | One shared household password, SHA-256 hash stored in `household_settings` |
| Offline | Service worker caches the app shell; data needs a connection |

The budget tables live alongside the ranch tables in the same Supabase project
(the free plan allows two projects and both slots were already used). Table names
don't collide with anything Ranch Manager uses.

### Files

```
index.html                 markup + all styling
app.js                     the entire app
vendor/supabase.js         Supabase JS client, vendored so it works offline
sw.js                      service worker
manifest.webmanifest       PWA manifest
icons/                     app icons
supabase/schema.sql        full schema, already applied — kept for rebuilds
test/                      Playwright smoke + logic tests (dev only)
```

---

## What's in it

**Dashboard** — cash on hand, net worth, month-to-date spend vs plan, income,
overdue and upcoming bills, budget progress, net worth trend, savings goals,
debt payoff, sinking fund balances.

**Bills** — add anything, recurring or one-off (weekly, every 2 weeks, twice a
month, monthly, quarterly, semiannual, yearly). Each occurrence is tracked
separately, so "paid" applies to a specific cycle rather than the bill as a
whole. Overdue and due-within-7-days are flagged.

**Budget** — categories you add, rename or retire at will. Planned vs actual
per month with a variance readout. Actuals roll up from two places: transactions
logged against a category, and bills marked paid that belong to it.

> One rule worth knowing: if you mark a bill paid, **don't also log a
> transaction for it** — it would count twice.

**Rollover** — per-category toggle. When it's on, whatever's left at month end
is added to next month's plan (already switched on for Home Repairs, Vehicle,
Medical, Clothing, Gifts, Ranch/Livestock, Miscellaneous — off for Groceries and
the rest). It applies automatically the first time the app opens in a new month,
and there's a manual "roll leftovers in" button on the Budget screen.

**Savings goals** — target, date, progress bar, and a per-month figure showing
what it takes to hit the date.

**Sinking funds** — buckets for irregular expenses (car repair, Christmas,
property taxes, vet bills, home maintenance are pre-created). Set a monthly
contribution and the app prompts once a month to add them all in one tap.
Balances draw down when you record a spend.

**Debt payoff** — any account typed as credit card or loan. Add the rate and
monthly payment and it estimates a payoff date and total interest. It says so
plainly when a payment doesn't cover the interest.

**Net worth** — snapshot button, trend chart, full history.

**Spending trends** — stacked bars by category over 3/6/12 months, month-over-
month movers, and a table view of the same numbers.

**Quick Add** — the ➕ button. Expense, income, or pay a bill, in a few taps.

**Weekly review** — six guided steps: reconcile balances, clear the week's
bills, confirm income, fund the sinking funds, check the budget, snapshot net
worth.

**Export** — JSON (full backup, restorable) and CSV, under More.

---

## Starting data

Placeholders are already in the database so nothing is a blank page — rename or
delete anything that doesn't fit:

- **8 accounts** — Primary Checking, Household Savings, Emergency Fund, Credit
  Card 1, Credit Card 2, Auto Loan, Mortgage, Cash on Hand (all at $0)
- **20 budget categories** — groceries through miscellaneous, all planned at $0
- **5 sinking funds** — car repair, Christmas, property taxes, vet bills, home
  maintenance

Bills, income, savings goals and transactions start empty.

**Fastest way to get going:** Accounts → tap each one → set the real name and
balance. Then Budget → set planned amounts. Then add your bills.

---

## A note on the password

The shared password gates the app, but the Supabase publishable key sits in
`app.js` — as it does in your other apps. Anyone who found the key could read
the data directly through Supabase's API. It's the right trade for a two-person
household app and matches how Ranch Manager works, but it's worth knowing it's a
convenience gate rather than bank-grade security.

---

## Running the tests (dev only)

```bash
npm install
python3 -m http.server 8899 &
node test/logic.mjs    # date, recurrence, rollover and payoff math
node test/smoke.mjs    # full click-through of every screen, writes screenshots
```

The tests swap in an in-memory stand-in for Supabase (`test/mock-supabase.js`)
so they run without touching the real database.
