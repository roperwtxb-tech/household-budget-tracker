-- =====================================================================
-- Household Budget Tracker — full schema
-- Already applied to the Supabase project `roped-in-ranch`
-- (hrtuhexblsbdjfdbfblg). Kept here so the database can be rebuilt from
-- scratch, or stood up in a second project, without guesswork.
-- =====================================================================

create extension if not exists "pgcrypto";

-- Single-row table holding the shared household password (SHA-256 hex).
create table if not exists public.household_settings (
  id int primary key default 1,
  password_hash text not null,
  app_name text not null default 'Household Budget Tracker',
  updated_at timestamptz not null default now(),
  constraint household_settings_singleton check (id = 1)
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'checking',   -- checking|savings|cash|investment|property|credit|loan|other
  balance numeric(14,2) not null default 0, -- for credit/loan this is the amount OWED, positive
  institution text,
  notes text,
  interest_rate numeric(6,3),               -- debt accounts: APR %
  minimum_payment numeric(14,2),            -- debt accounts: monthly payment
  target_payoff_date date,                  -- debt accounts: your own goal
  include_in_net_worth boolean not null default true,
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.budget_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  monthly_planned_amount numeric(14,2) not null default 0,
  rollover_enabled boolean not null default false,
  color text,
  archived boolean not null default false,   -- "retired" rather than deleted
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Per-month overrides and rollover carry for a category.
create table if not exists public.budget_entries (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.budget_categories(id) on delete cascade,
  month date not null,                       -- always the 1st of the month
  planned_override numeric(14,2),
  rolled_over_amount numeric(14,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  unique (category_id, month)
);

-- A bill is a template; occurrences are generated from due_date + recurrence.
create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  amount numeric(14,2) not null default 0,
  due_date date not null,                    -- anchor date for the recurrence
  category_id uuid references public.budget_categories(id) on delete set null,
  recurrence text not null default 'monthly', -- once|weekly|biweekly|semimonthly|monthly|quarterly|semiannual|annual
  autopay boolean not null default false,
  account_id uuid references public.accounts(id) on delete set null,
  notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per bill occurrence that has been touched (paid / unpaid).
create table if not exists public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  cycle_date date not null,
  paid boolean not null default false,
  paid_date date,
  paid_amount numeric(14,2),
  paid_from_account_id uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (bill_id, cycle_date)
);

create table if not exists public.income (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  amount numeric(14,2) not null default 0,
  date date not null,
  recurrence text not null default 'once',
  account_id uuid references public.accounts(id) on delete set null,
  received boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

-- Ad-hoc spending / income logged through Quick Add.
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  date date not null default current_date,
  description text not null default '',
  amount numeric(14,2) not null default 0,
  kind text not null default 'expense',      -- expense|income
  category_id uuid references public.budget_categories(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  target_amount numeric(14,2) not null default 0,
  target_date date,
  current_amount numeric(14,2) not null default 0,
  linked_account_id uuid references public.accounts(id) on delete set null,
  notes text,
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.sinking_funds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  target_amount numeric(14,2),
  monthly_contribution numeric(14,2) not null default 0,
  current_balance numeric(14,2) not null default 0,
  last_contribution_month date,              -- guards against double-contributing
  notes text,
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.sinking_fund_entries (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.sinking_funds(id) on delete cascade,
  date date not null default current_date,
  amount numeric(14,2) not null default 0,
  kind text not null default 'contribution', -- contribution|withdrawal
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  total_assets numeric(14,2) not null default 0,
  total_liabilities numeric(14,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  unique (snapshot_date)
);

create index if not exists idx_bill_payments_cycle on public.bill_payments(cycle_date);
create index if not exists idx_transactions_date on public.transactions(date);
create index if not exists idx_transactions_category on public.transactions(category_id);
create index if not exists idx_income_date on public.income(date);
create index if not exists idx_bills_due on public.bills(due_date);

-- ---------------------------------------------------------------------
-- RLS: same pattern as Ranch Manager — one shared household, gated by the
-- app's password screen rather than per-user Supabase auth.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'household_settings','accounts','budget_categories','budget_entries','bills',
    'bill_payments','income','transactions','savings_goals','sinking_funds',
    'sinking_fund_entries','net_worth_snapshots'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "allow all for anon" on public.%I', t);
    execute format('create policy "allow all for anon" on public.%I for all to anon using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Realtime: without this, changes on one phone never reach the other.
-- REPLICA IDENTITY FULL makes DELETE events carry the old row.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'accounts','bills','bill_payments','income','budget_categories','budget_entries',
    'transactions','savings_goals','sinking_funds','sinking_fund_entries','net_worth_snapshots'
  ] loop
    execute format('alter table public.%I replica identity full', t);
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Seed: household password + starter categories, accounts and funds.
-- The hash below is SHA-256 of the password chosen at setup; change it in
-- the app under More -> Settings -> Change household password.
-- ---------------------------------------------------------------------
insert into public.household_settings (id, password_hash, app_name)
values (1, '35d05813a0619bc2c853cddcb1c9d7848b2a5ce4800e2d3328181c9176711a3b', 'Household Budget Tracker')
on conflict (id) do nothing;
