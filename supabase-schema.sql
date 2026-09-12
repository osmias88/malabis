-- Minimal schema for Malabis product ingestion and price tracking

create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists profiles_select_own on profiles;
create policy profiles_select_own on profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles
  for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create table if not exists brands (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  family text,
  market text,
  base_url text not null,
  currency text default 'PKR',
  adapter text,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  external_id text not null,
  handle text not null,
  title text not null,
  description text,
  url text,
  product_type text,
  vendor text,
  source text,
  price_min bigint,
  price_max bigint,
  currency text default 'PKR',
  stock_status text,
  scraped_at timestamptz not null default now(),
  unique (brand_id, handle)
);

alter table products add column if not exists tags text[] not null default '{}';
alter table products add column if not exists images jsonb not null default '[]'::jsonb;
alter table products add column if not exists active boolean not null default true;
alter table products add column if not exists first_seen_at timestamptz not null default now();
alter table products add column if not exists last_seen_at timestamptz;
alter table products add column if not exists source_updated_at timestamptz;

create table if not exists variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  external_id text,
  sku text,
  title text,
  size text,
  raw_size text,
  color text,
  price bigint,
  compare_at_price bigint,
  available boolean,
  inventory_quantity integer,
  position integer,
  unique (product_id, external_id)
);

create table if not exists scrape_runs (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  products_found integer default 0,
  products_parsed integer default 0,
  request_count integer default 0,
  error text
);

create table if not exists price_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  variant_id uuid references variants(id) on delete set null,
  price bigint not null,
  currency text not null default 'PKR',
  captured_at timestamptz not null default now()
);

create table if not exists stock_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  variant_id uuid references variants(id) on delete set null,
  available boolean,
  inventory_quantity integer,
  captured_at timestamptz not null default now()
);

create index if not exists idx_products_brand_id on products(brand_id);
create index if not exists idx_products_active_brand on products(brand_id, active, last_seen_at desc);
create index if not exists idx_variants_product_id on variants(product_id);
create index if not exists idx_price_history_product_id on price_history(product_id, captured_at desc);
create index if not exists idx_stock_history_product_id on stock_history(product_id, captured_at desc);
