-- Portfolio Tracker — schema Supabase / PostgreSQL
-- Esegui nel SQL Editor di Supabase (Database → SQL Editor → New query).
-- Idempotente: puoi rilanciarlo senza rompere nulla.

-- ─────────────────────────────────────────────────────────────
-- Tabella: portfolios
-- Un blob JSONB per utente. Stessa forma di data/config.json:
--   { version, totalCash, assets[], startups[], assetClasses[], goldEtf, physGold }
-- Chiave = user_id (1 riga per utente). RLS isola i dati.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.portfolios (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Tabella: snapshots
-- Uno snapshot mensile per riga. Upsert per (user_id, year, month),
-- come oggi fa POST /api/snapshot con findIndex su month/year.
--   assets jsonb = [{ id, name, price, quantity, value }]
-- ─────────────────────────────────────────────────────────────
create table if not exists public.snapshots (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  label       text        not null,           -- es. "Mar 2026" (display + delete-by-label)
  year        int         not null,
  month       int         not null check (month between 1 and 12),
  total_value numeric     not null default 0,
  assets      jsonb       not null default '[]'::jsonb,
  saved_at    timestamptz not null default now(),
  unique (user_id, year, month)               -- garantisce l'upsert mensile
);

create index if not exists snapshots_user_idx on public.snapshots (user_id);

-- ─────────────────────────────────────────────────────────────
-- Trigger: updated_at automatico su portfolios
-- ─────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists portfolios_set_updated_at on public.portfolios;
create trigger portfolios_set_updated_at
  before update on public.portfolios
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- Row Level Security
-- Difesa a livello DB: ogni utente vede/scrive solo le proprie righe,
-- anche se il backend sbaglia. La service-role key del backend
-- bypassa RLS by design; queste policy proteggono il path anon key.
-- ─────────────────────────────────────────────────────────────
alter table public.portfolios enable row level security;
alter table public.snapshots  enable row level security;

-- portfolios
drop policy if exists portfolios_select on public.portfolios;
create policy portfolios_select on public.portfolios
  for select using (auth.uid() = user_id);

drop policy if exists portfolios_insert on public.portfolios;
create policy portfolios_insert on public.portfolios
  for insert with check (auth.uid() = user_id);

drop policy if exists portfolios_update on public.portfolios;
create policy portfolios_update on public.portfolios
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists portfolios_delete on public.portfolios;
create policy portfolios_delete on public.portfolios
  for delete using (auth.uid() = user_id);

-- snapshots
drop policy if exists snapshots_select on public.snapshots;
create policy snapshots_select on public.snapshots
  for select using (auth.uid() = user_id);

drop policy if exists snapshots_insert on public.snapshots;
create policy snapshots_insert on public.snapshots
  for insert with check (auth.uid() = user_id);

drop policy if exists snapshots_update on public.snapshots;
create policy snapshots_update on public.snapshots
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists snapshots_delete on public.snapshots;
create policy snapshots_delete on public.snapshots
  for delete using (auth.uid() = user_id);
