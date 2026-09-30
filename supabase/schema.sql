-- Trade Terminal database schema.
-- Run in Supabase → SQL Editor. Safe to run again (idempotent).
--
-- Access model: only rows in public.profiles with active = true ("staff")
-- can read or change data. New sign-ups start inactive, so even if public
-- sign-up is left on, a stranger who registers sees nothing.

-- ---------------------------------------------------------------------------
-- Staff profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

-- New auth users get an inactive profile automatically.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, active)
  values (new.id, new.email, initcap(split_part(new.email, '@', 1)), false)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users that already exist when this script runs are activated.
insert into public.profiles (id, email, display_name, active)
select id, email, initcap(split_part(email, '@', 1)), true
from auth.users
on conflict (id) do nothing;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

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
  user_id uuid default auth.uid() references auth.users (id),
  user_name text not null default '',
  ip text not null default '',
  add_time timestamptz not null default now()
);

create index if not exists trades_trade_date_idx on public.trades (trade_date);
create index if not exists trades_client_code_idx on public.trades (client_code);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.accounts enable row level security;
alter table public.brokerage_slabs enable row level security;
alter table public.trades enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists "staff full access" on public.accounts;
create policy "staff full access" on public.accounts
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "staff full access" on public.brokerage_slabs;
create policy "staff full access" on public.brokerage_slabs
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "staff full access" on public.trades;
create policy "staff full access" on public.trades
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- Realtime: other operators' changes appear without refreshing
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['accounts', 'brokerage_slabs', 'trades'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Adding another operator later:
--   1. Supabase → Authentication → Users → Add user (email + password, auto-confirm)
--   2. Run:  update public.profiles set active = true, display_name = 'Name' where email = 'their@email';
-- ---------------------------------------------------------------------------
