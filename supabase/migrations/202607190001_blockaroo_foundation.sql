-- Durable Blockaroo data. Fast movement, presence, and nearby conversation
-- intentionally live in the world WebSocket worker instead of these tables.

create extension if not exists pgcrypto;

create table if not exists public.cities (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  name text not null check (char_length(name) between 1 and 60),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  city_id text not null references public.cities(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9-]+$'),
  kind text not null check (kind in ('town-square', 'overworld', 'house', 'theater')),
  owner_id uuid references auth.users(id) on delete cascade,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  unique (city_id, slug),
  check ((kind = 'house' and owner_id is not null) or kind <> 'house')
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'New Neighbor' check (char_length(display_name) between 1 and 18),
  block_color text not null default '#ff6b6b' check (block_color ~ '^#[0-9a-fA-F]{6}$'),
  home_city_id text not null default 'nashville' references public.cities(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.homes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  city_id text not null references public.cities(id),
  space_id uuid unique references public.spaces(id) on delete set null,
  name text not null default 'My Block' check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.neighbors (
  user_id uuid not null references auth.users(id) on delete cascade,
  neighbor_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, neighbor_id),
  check (user_id <> neighbor_id)
);

create table if not exists public.block_drops (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('text', 'photo')),
  body text check (body is null or char_length(body) <= 500),
  object_path text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  check ((kind = 'text' and body is not null) or (kind = 'photo' and object_path is not null))
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists homes_set_updated_at on public.homes;
create trigger homes_set_updated_at before update on public.homes
for each row execute function public.set_updated_at();

drop trigger if exists neighbors_set_updated_at on public.neighbors;
create trigger neighbors_set_updated_at before update on public.neighbors
for each row execute function public.set_updated_at();

insert into public.cities (id, name, is_active)
values ('nashville', 'Nashville', true)
on conflict (id) do update set name = excluded.name, is_active = excluded.is_active;

insert into public.spaces (city_id, slug, kind, is_public)
values ('nashville', 'town-square', 'town-square', true)
on conflict (city_id, slug) do update set kind = excluded.kind, is_public = excluded.is_public;

alter table public.cities enable row level security;
alter table public.spaces enable row level security;
alter table public.profiles enable row level security;
alter table public.homes enable row level security;
alter table public.neighbors enable row level security;
alter table public.block_drops enable row level security;

create policy "cities are readable"
on public.cities for select to authenticated
using (is_active);

create policy "public or owned spaces are readable"
on public.spaces for select to authenticated
using (is_public or owner_id = (select auth.uid()));

create policy "users can create owned spaces"
on public.spaces for insert to authenticated
with check (owner_id = (select auth.uid()));

create policy "users can update owned spaces"
on public.spaces for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy "profiles are readable"
on public.profiles for select to authenticated
using (true);

create policy "users can create their profile"
on public.profiles for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "users can update their profile"
on public.profiles for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "owners can read homes"
on public.homes for select to authenticated
using (owner_id = (select auth.uid()));

create policy "owners can create homes"
on public.homes for insert to authenticated
with check (owner_id = (select auth.uid()));

create policy "owners can update homes"
on public.homes for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy "participants can read neighbor links"
on public.neighbors for select to authenticated
using (user_id = (select auth.uid()) or neighbor_id = (select auth.uid()));

create policy "users can request neighbors"
on public.neighbors for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "participants can update neighbor links"
on public.neighbors for update to authenticated
using (user_id = (select auth.uid()) or neighbor_id = (select auth.uid()))
with check (user_id = (select auth.uid()) or neighbor_id = (select auth.uid()));

create policy "participants can delete neighbor links"
on public.neighbors for delete to authenticated
using (user_id = (select auth.uid()) or neighbor_id = (select auth.uid()));

create policy "participants can read block drops"
on public.block_drops for select to authenticated
using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));

create policy "users can create block drops"
on public.block_drops for insert to authenticated
with check (sender_id = (select auth.uid()));

create policy "participants can delete block drops"
on public.block_drops for delete to authenticated
using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));

grant select on public.cities to authenticated;
grant select, insert, update on public.spaces to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.homes to authenticated;
grant select, insert, delete on public.neighbors to authenticated;
grant update (status) on public.neighbors to authenticated;
grant select, insert, delete on public.block_drops to authenticated;
