-- One lightweight, owner-controlled layout now drives both the Neighborhood
-- cutaway preview and the full multiplayer Block Home room.

alter table public.homes
  add column if not exists interior_layout jsonb not null default
  '{
    "version": 1,
    "wallColor": "#f3dfbd",
    "floorColor": "#d2aa78",
    "lighting": "warm",
    "furniture": [
      {"id":"rug-1","kind":"rug","x":47,"y":73,"rotation":0,"color":"#8e9bd4"},
      {"id":"sofa-1","kind":"sofa","x":31,"y":72,"rotation":0,"color":"#ff6b6b"},
      {"id":"table-1","kind":"coffee-table","x":51,"y":71,"rotation":0,"color":"#9a6b42"},
      {"id":"chair-1","kind":"armchair","x":69,"y":72,"rotation":0,"color":"#4cc9f0"},
      {"id":"tv-1","kind":"tv","x":70,"y":44,"rotation":0,"color":"#273247"},
      {"id":"lamp-1","kind":"floor-lamp","x":15,"y":53,"rotation":0,"color":"#ffd166"},
      {"id":"plant-1","kind":"plant","x":84,"y":54,"rotation":0,"color":"#3e8c72"},
      {"id":"bookshelf-1","kind":"bookshelf","x":28,"y":43,"rotation":0,"color":"#c78a52"}
    ]
  }'::jsonb;

update public.homes as home
set interior_layout = jsonb_set(
  home.interior_layout,
  '{furniture,1,color}',
  to_jsonb(profile.block_color),
  false
)
from public.profiles as profile
where profile.user_id = home.owner_id;

alter table public.homes
  drop constraint if exists homes_interior_layout_check,
  add constraint homes_interior_layout_check check (
    jsonb_typeof(interior_layout) = 'object'
    and interior_layout ->> 'version' = '1'
    and coalesce(interior_layout ->> 'wallColor', '') ~ '^#[0-9a-fA-F]{6}$'
    and coalesce(interior_layout ->> 'floorColor', '') ~ '^#[0-9a-fA-F]{6}$'
    and interior_layout ->> 'lighting' in ('day', 'warm', 'night')
    and jsonb_typeof(interior_layout -> 'furniture') = 'array'
    and jsonb_array_length(interior_layout -> 'furniture') <= 24
    and pg_column_size(interior_layout) <= 16384
  );

-- The room is a friends-only profile preview. Door modes continue to control
-- actual multiplayer tickets through can_visit_home; they no longer hide the
-- harmless cutaway layout from an accepted neighbor.
drop policy if exists "owners and friends can read homes" on public.homes;
create policy "owners and accepted friends can read home profiles"
on public.homes for select to authenticated
using (
  owner_id = (select auth.uid())
  or (
    public.is_social_ready_user()
    and public.are_friends(owner_id, (select auth.uid()))
  )
);

comment on column public.homes.interior_layout is
  'Versioned Block Home wall, floor, lighting, and furniture layout. Client rendering normalizes every item.';

alter table public.homes replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'homes'
  ) then
    alter publication supabase_realtime add table public.homes;
  end if;
end;
$$;
