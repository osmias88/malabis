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

-- Brand's delivery charge within Pakistan (to Lahore), in the brand's
-- currency minor units, refreshed daily and added to displayed prices.
alter table brands add column if not exists delivery_amount bigint;
alter table brands add column if not exists delivery_free_over bigint;
alter table brands add column if not exists delivery_checked_at timestamptz;

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
alter table products add column if not exists published_at timestamptz;

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

-- Catalogue tables are only read and written by the server and scraper with
-- the service-role key, which bypasses RLS. Enabling RLS with no policies
-- blocks the public anon key (shipped to browsers for sign-in) from them.
alter table brands enable row level security;
alter table products enable row level security;
alter table variants enable row level security;
alter table scrape_runs enable row level security;
alter table price_history enable row level security;
alter table stock_history enable row level security;

-- ---------- Customer accounts: details, saved bag, orders ----------

alter table profiles add column if not exists phone text;
alter table profiles add column if not exists address_line1 text;
alter table profiles add column if not exists address_line2 text;
alter table profiles add column if not exists city text;
alter table profiles add column if not exists region text;
alter table profiles add column if not exists postal_code text;
alter table profiles add column if not exists country text not null default 'US';

-- A signed-in customer's bag, kept across devices. Prices are re-checked at checkout.
create table if not exists cart_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null,
  variant_id text not null,
  quantity integer not null check (quantity between 1 and 10),
  snapshot jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, product_key, variant_id)
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity (start with 1001) unique,
  user_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'awaiting_payment',
  currency text not null default 'USD',
  subtotal bigint not null,
  shipping_address jsonb not null,
  contact_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  brand_key text not null,
  product_external_id text not null,
  variant_external_id text not null,
  title text not null,
  brand_name text,
  size text,
  image_url text,
  product_url text,
  quantity integer not null check (quantity between 1 and 10),
  unit_price bigint not null,
  unit_price_source bigint,
  source_currency text
);

-- Status history, for customer updates and the warehouse portal.
create table if not exists order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  status text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_cart_items_user on cart_items(user_id);
create index if not exists idx_orders_user on orders(user_id, created_at desc);
create index if not exists idx_order_items_order on order_items(order_id);
create index if not exists idx_order_events_order on order_events(order_id, created_at);

-- Customers may read only their own rows; all writes go through the server.
alter table cart_items enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_events enable row level security;

drop policy if exists cart_items_select_own on cart_items;
create policy cart_items_select_own on cart_items for select using (auth.uid() = user_id);

drop policy if exists orders_select_own on orders;
create policy orders_select_own on orders for select using (auth.uid() = user_id);

drop policy if exists order_items_select_own on order_items;
create policy order_items_select_own on order_items for select
  using (exists (select 1 from orders where orders.id = order_items.order_id and orders.user_id = auth.uid()));

drop policy if exists order_events_select_own on order_events;
create policy order_events_select_own on order_events for select
  using (exists (select 1 from orders where orders.id = order_events.order_id and orders.user_id = auth.uid()));
