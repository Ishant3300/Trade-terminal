-- Trade Terminal database schema.
-- Run in Supabase → SQL Editor. Safe to run again (idempotent).
--
-- Access model: only the app's server talks to the database, using the
-- secret key (which bypasses RLS). RLS is enabled with no policies and table
-- privileges are revoked, so the publishable/anon key can read or change
-- nothing.

-- ---------------------------------------------------------------------------
-- Account master
-- ---------------------------------------------------------------------------
create table if not exists public.accounts (
  code text primary key check (code ~ '^[A-Z0-9]{2,10}$'),
  name text not null,
  type text not null check (type in ('Customer', 'Self', 'Broker')),
  opening_balance numeric(16, 2) not null default 0 check (opening_balance >= 0),
  opening_type text not null default 'Cr' check (opening_type in ('Dr', 'Cr')),
  mobile text not null default '',
  email text not null default '',
  address text not null default '',
  remark text not null default '',
  interest_pct numeric(6, 2) not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Brokerage slabs (one per client + segment + script scope)
-- ---------------------------------------------------------------------------
create table if not exists public.brokerage_slabs (
  id bigint generated always as identity primary key,
  client_code text not null references public.accounts (code) on update cascade on delete cascade,
  segment text not null check (segment in ('NSEFUT', 'NSEOPT', 'MCXFUT', 'NCDEX', 'NSEEQ')),
  script_wise boolean not null default false,
  script text not null default '',
  mode text not null check (mode in ('PCT', 'FIX')),
  del_pct numeric(10, 4) not null default 0,
  intra_pct numeric(10, 4) not null default 0,
  fix_del numeric(12, 2) not null default 0,
  fix_intra numeric(12, 2) not null default 0,
  higher_side_only boolean not null default false,
  min_rate numeric(12, 4) not null default 0,
  min_pct numeric(10, 4) not null default 0,
  min_pct_on_del numeric(10, 4) not null default 0,
  created_at timestamptz not null default now(),
  unique (client_code, segment, script_wise, script)
);

-- ---------------------------------------------------------------------------
-- Trades
-- ---------------------------------------------------------------------------
create table if not exists public.trades (
  id bigint generated always as identity primary key,
  ot text not null default 'T' check (ot in ('O', 'T')),
  trade_date date not null,
  valan text not null default '',
  segment text not null check (segment in ('NSEFUT', 'NSEOPT', 'MCXFUT', 'NCDEX', 'NSEEQ')),
  script text not null,
  option_type text not null default '' check (option_type in ('', 'CE', 'PE')),
  strike numeric(12, 2) not null default 0,
  trade_type text not null default 'NRM' check (trade_type in ('NRM', 'CF', 'BF')),
  side text not null check (side in ('B', 'S')),
  lot integer not null check (lot >= 0),
  qty integer not null check (qty > 0),
  rate numeric(14, 4) not null check (rate > 0),
  client_code text not null references public.accounts (code) on update cascade on delete restrict,
  user_name text not null default '',
  ip text not null default '',
  add_time timestamptz not null default now()
);

create index if not exists trades_trade_date_idx on public.trades (trade_date);
create index if not exists trades_client_code_idx on public.trades (client_code);

-- ---------------------------------------------------------------------------
-- Angel One SmartAPI session, shared by all server instances (one row)
-- ---------------------------------------------------------------------------
create table if not exists public.broker_session (
  id integer primary key check (id = 1),
  jwt text not null,
  feed_token text,
  day date not null,
  updated_at timestamptz not null default now()
);

alter table public.broker_session add column if not exists feed_token text;

-- ---------------------------------------------------------------------------
-- Lock down: no access for the publishable (anon) key or Supabase logins
-- ---------------------------------------------------------------------------
alter table public.accounts enable row level security;
alter table public.brokerage_slabs enable row level security;
alter table public.trades enable row level security;
alter table public.broker_session enable row level security;

revoke all on table public.accounts, public.brokerage_slabs, public.trades, public.broker_session from anon, authenticated;
