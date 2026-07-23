-- Blockaroo's durable social layer. Live movement, nearby talk, Circle voice
-- signaling, and game state stay in the Cloudflare world room.

create extension if not exists pg_cron;

alter table public.profiles
  add column if not exists handle text,
  add column if not exists bio text not null default '',
  add column if not exists interests text[] not null default '{}',
  add column if not exists profile_photo_path text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists age_confirmed_at timestamptz,
  add column if not exists terms_version text;

alter table public.profiles
  drop constraint if exists profiles_handle_check,
  add constraint profiles_handle_check
    check (handle is null or handle ~ '^[a-z0-9_]{3,20}$'),
  drop constraint if exists profiles_bio_check,
  add constraint profiles_bio_check check (char_length(bio) <= 240),
  drop constraint if exists profiles_interests_check,
  add constraint profiles_interests_check check (cardinality(interests) <= 12);

create unique index if not exists profiles_handle_unique
  on public.profiles (lower(handle))
  where handle is not null;

alter table public.homes
  add column if not exists access_mode text not null default 'knock',
  add column if not exists welcome_note text not null default '';

alter table public.homes
  drop constraint if exists homes_access_mode_check,
  add constraint homes_access_mode_check
    check (access_mode in ('open', 'knock', 'invite', 'dnd', 'away')),
  drop constraint if exists homes_welcome_note_check,
  add constraint homes_welcome_note_check check (char_length(welcome_note) <= 180);

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.safety_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('harassment', 'hate', 'sexual', 'spam', 'impersonation', 'unsafe', 'other')),
  details text not null default '' check (char_length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'reviewing', 'closed')),
  created_at timestamptz not null default now(),
  check (reporter_id <> target_id)
);

create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 500),
  media_path text,
  media_type text check (media_type is null or media_type in ('image', 'gif')),
  location_label text check (
    location_label is null
    or location_label in ('Town Square', 'Downtown', 'East Nashville', 'The Gulch', 'Centennial Park')
  ),
  visibility text not null default 'friends' check (visibility = 'friends'),
  pinned_to_home boolean not null default false,
  media_ready boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  check (char_length(trim(body)) > 0 or media_path is not null),
  check ((media_path is null and media_type is null) or (media_path is not null and media_type is not null)),
  check (media_path is null or media_path ~ '^social/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|gif)$')
);

alter table public.social_posts
  add column if not exists media_ready boolean not null default true;

alter table public.social_posts
  drop constraint if exists social_posts_media_owner_check,
  add constraint social_posts_media_owner_check check (
    media_path is null
    or media_path = (
      'social/' || author_id::text || '/' || id::text
      || case when media_type = 'gif' then '.gif' else '.jpg' end
    )
  );

create index if not exists social_posts_feed_index
  on public.social_posts (created_at desc)
  where visibility = 'friends';

create index if not exists social_posts_author_index
  on public.social_posts (author_id, created_at desc);

create index if not exists social_posts_expiration_index
  on public.social_posts (expires_at)
  where pinned_to_home = false;

create table if not exists public.home_invitations (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users(id) on delete cascade,
  guest_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'invite' check (kind in ('invite', 'knock')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  check (host_id <> guest_id)
);

alter table public.home_invitations
  add column if not exists kind text not null default 'invite';

alter table public.home_invitations
  drop constraint if exists home_invitations_kind_check,
  add constraint home_invitations_kind_check check (kind in ('invite', 'knock'));

create or replace function public.prepare_social_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.author_id <> (select auth.uid()) then
      raise exception 'Post author does not match the current user.';
    end if;
    if (
      select count(*)
      from public.social_posts
      where author_id = new.author_id
        and created_at > now() - interval '1 minute'
    ) >= 6 or (
      select count(*)
      from public.social_posts
      where author_id = new.author_id
        and created_at > now() - interval '24 hours'
    ) >= 100 then
      raise exception 'Too many Block Posts. Try again later.';
    end if;
    if new.pinned_to_home and (
      select count(*)
      from public.social_posts
      where author_id = new.author_id
        and pinned_to_home
    ) >= 12 then
      raise exception 'A Block Home can display at most 12 pinned posts.';
    end if;
    new.created_at := now();
    new.expires_at := now() + interval '24 hours';
    new.visibility := 'friends';
    new.media_ready := new.media_path is null;
    return new;
  end if;

  new.author_id := old.author_id;
  new.created_at := old.created_at;
  new.expires_at := old.expires_at;
  new.visibility := old.visibility;
  new.media_path := old.media_path;
  new.media_type := old.media_type;
  -- R2 expiration metadata is chosen at upload time, so a post cannot be
  -- converted between temporary and persistent storage with a raw row update.
  new.pinned_to_home := old.pinned_to_home;
  return new;
end;
$$;

drop trigger if exists social_posts_prepare on public.social_posts;
create trigger social_posts_prepare
before insert or update on public.social_posts
for each row execute function public.prepare_social_post();

create or replace function public.prepare_safety_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reporter_id <> (select auth.uid()) then
    raise exception 'Report author does not match the current user.';
  end if;
  if (
    select count(*)
    from public.safety_reports
    where reporter_id = new.reporter_id
      and created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'Too many reports. Try again later.';
  end if;
  new.status := 'open';
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists safety_reports_prepare on public.safety_reports;
create trigger safety_reports_prepare
before insert on public.safety_reports
for each row execute function public.prepare_safety_report();

create unique index if not exists home_invitations_pending_unique
  on public.home_invitations (host_id, guest_id)
  where status = 'pending';

create or replace function public.is_permanent_user()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, true);
$$;

create or replace function public.is_social_ready_user_id(candidate_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select candidate_user is not null
    and exists (
      select 1
      from auth.users
      where id = candidate_user
        and not coalesce(is_anonymous, false)
    )
    and exists (
      select 1
      from public.profiles
      where user_id = candidate_user
        and terms_accepted_at is not null
        and age_confirmed_at is not null
        and terms_version = '2026-07'
    );
$$;

create or replace function public.has_block_between(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
    (select auth.uid()) = first_user
    or (select auth.uid()) = second_user
  ) and exists (
      select 1
      from public.user_blocks
      where (blocker_id = first_user and blocked_id = second_user)
         or (blocker_id = second_user and blocked_id = first_user)
    );
$$;

create or replace function public.is_social_ready_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_social_ready_user_id((select auth.uid()));
$$;

create or replace function public.are_friends(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
    (select auth.uid()) = first_user
    or (select auth.uid()) = second_user
  ) and (
    first_user = second_user or (
      not public.has_block_between(first_user, second_user)
      and exists (
        select 1
        from public.neighbors
        where status = 'accepted'
          and (
            (user_id = first_user and neighbor_id = second_user)
            or (user_id = second_user and neighbor_id = first_user)
          )
      )
    )
  );
$$;

create or replace function public.can_visit_home(home_owner uuid, visitor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select visitor = (select auth.uid()) and (
    home_owner = visitor or (
    public.are_friends(home_owner, visitor)
    and exists (
      select 1
      from public.homes
      where owner_id = home_owner
        and (
          access_mode in ('open', 'away')
          or (
            access_mode in ('knock', 'invite')
            and exists (
              select 1
              from public.home_invitations
              where host_id = home_owner
                and guest_id = visitor
                and status = 'accepted'
                and expires_at > now()
            )
          )
        )
    )
  ));
$$;

create or replace function public.send_friend_request(target_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null or not public.is_social_ready_user() then
    raise exception 'A permanent account is required.';
  end if;
  if target_user is null or target_user = current_user_id then
    raise exception 'Choose another player.';
  end if;
  if not public.is_social_ready_user_id(target_user) then
    raise exception 'That player has not finished account setup.';
  end if;
  if public.has_block_between(current_user_id, target_user) then
    raise exception 'That connection is unavailable.';
  end if;
  if public.are_friends(current_user_id, target_user) then
    return 'accepted';
  end if;
  if exists (
    select 1
    from public.neighbors
    where user_id = current_user_id
      and neighbor_id = target_user
      and status = 'pending'
      and updated_at > now() - interval '1 minute'
  ) then
    raise exception 'That friend request is already waiting for an answer.';
  end if;
  if (
    select count(*)
    from public.neighbors
    where user_id = current_user_id
      and status = 'pending'
      and created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'Too many friend requests. Try again later.';
  end if;

  update public.neighbors
  set status = 'accepted', updated_at = now()
  where user_id = target_user
    and neighbor_id = current_user_id
    and status = 'pending';
  if found then
    return 'accepted';
  end if;

  insert into public.neighbors (user_id, neighbor_id, status)
  values (current_user_id, target_user, 'pending')
  on conflict (user_id, neighbor_id)
  do update set status = 'pending', updated_at = now();
  return 'pending';
end;
$$;

create or replace function public.respond_friend_request(requester_user uuid, accept_request boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null or not public.is_social_ready_user() then
    raise exception 'A permanent account is required.';
  end if;
  if public.has_block_between(current_user_id, requester_user) then
    delete from public.neighbors
    where user_id = requester_user and neighbor_id = current_user_id and status = 'pending';
    return 'declined';
  end if;

  if accept_request then
    update public.neighbors
    set status = 'accepted', updated_at = now()
    where user_id = requester_user
      and neighbor_id = current_user_id
      and status = 'pending';
    if not found then
      raise exception 'Friend request not found.';
    end if;
    return 'accepted';
  end if;

  delete from public.neighbors
  where user_id = requester_user
    and neighbor_id = current_user_id
    and status = 'pending';
  return 'declined';
end;
$$;

create or replace function public.cancel_friend_request(target_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.neighbors
  where user_id = (select auth.uid())
    and neighbor_id = target_user
    and status = 'pending';
$$;

create or replace function public.remove_friend(other_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.neighbors
  where status = 'accepted'
    and (
      (user_id = (select auth.uid()) and neighbor_id = other_user)
      or (neighbor_id = (select auth.uid()) and user_id = other_user)
    );
$$;

create or replace function public.block_user(target_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null or target_user is null or target_user = current_user_id then
    raise exception 'Choose another player.';
  end if;
  if not exists (
    select 1
    from public.user_blocks
    where blocker_id = current_user_id and blocked_id = target_user
  ) and (
    select count(*)
    from public.user_blocks
    where blocker_id = current_user_id
  ) >= 200 then
    raise exception 'Your block list is full. Remove an older block first.';
  end if;
  insert into public.user_blocks (blocker_id, blocked_id)
  values (current_user_id, target_user)
  on conflict do nothing;
  delete from public.neighbors
  where (user_id = current_user_id and neighbor_id = target_user)
     or (neighbor_id = current_user_id and user_id = target_user);
end;
$$;

create or replace function public.unblock_user(target_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.user_blocks
  where blocker_id = (select auth.uid()) and blocked_id = target_user;
$$;

create or replace function public.invite_to_home(target_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  invitation_id uuid;
begin
  if current_user_id is null or not public.is_social_ready_user() then
    raise exception 'A permanent account is required.';
  end if;
  if not public.are_friends(current_user_id, target_user) then
    raise exception 'Home invitations are for accepted friends.';
  end if;
  if exists (
    select 1
    from public.home_invitations
    where host_id = current_user_id
      and guest_id = target_user
      and kind = 'invite'
      and status = 'pending'
      and created_at > now() - interval '1 minute'
  ) then
    raise exception 'That invitation is already waiting for an answer.';
  end if;
  if (
    select count(*)
    from public.home_invitations
    where host_id = current_user_id
      and kind = 'invite'
      and created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'Too many home invitations. Try again later.';
  end if;

  insert into public.home_invitations (host_id, guest_id, kind)
  values (current_user_id, target_user, 'invite')
  on conflict (host_id, guest_id) where status = 'pending'
  do update set kind = 'invite', created_at = now(), expires_at = now() + interval '24 hours'
  returning id into invitation_id;
  return invitation_id;
end;
$$;

create or replace function public.knock_on_home(home_owner uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  door_mode text;
begin
  if current_user_id is null or not public.is_social_ready_user() then
    raise exception 'A permanent account is required.';
  end if;
  if not public.are_friends(current_user_id, home_owner) then
    raise exception 'Block Homes are available to accepted friends.';
  end if;

  select access_mode into door_mode
  from public.homes
  where owner_id = home_owner;
  if door_mode is null then
    raise exception 'That Block Home is unavailable.';
  end if;
  if door_mode in ('open', 'away') then
    return 'open';
  end if;
  if door_mode = 'dnd' then
    raise exception 'That Block Home is not accepting visitors right now.';
  end if;
  if exists (
    select 1
    from public.home_invitations
    where host_id = home_owner
      and guest_id = current_user_id
      and status = 'accepted'
      and expires_at > now()
  ) then
    return 'open';
  end if;
  update public.home_invitations
  set status = 'accepted'
  where host_id = home_owner
    and guest_id = current_user_id
    and kind = 'invite'
    and status = 'pending'
    and expires_at > now();
  if found then
    return 'open';
  end if;
  if door_mode <> 'knock' then
    raise exception 'That Block Home is invite only right now.';
  end if;
  if exists (
    select 1
    from public.home_invitations
    where host_id = home_owner
      and guest_id = current_user_id
      and kind = 'knock'
      and status = 'pending'
      and created_at > now() - interval '1 minute'
  ) then
    raise exception 'You already knocked. Give them a minute to answer.';
  end if;
  if (
    select count(*)
    from public.home_invitations
    where guest_id = current_user_id
      and kind = 'knock'
      and created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'Too many knocks. Try again later.';
  end if;

  insert into public.home_invitations (host_id, guest_id, kind)
  values (home_owner, current_user_id, 'knock')
  on conflict (host_id, guest_id) where status = 'pending'
  do update set kind = 'knock', created_at = now(), expires_at = now() + interval '24 hours';
  return 'knocked';
end;
$$;

create or replace function public.respond_home_invitation(invitation_id uuid, accept_invitation boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.home_invitations
  set status = case when accept_invitation then 'accepted' else 'declined' end
  where id = invitation_id
    and (
      (kind = 'invite' and guest_id = (select auth.uid()))
      or (kind = 'knock' and host_id = (select auth.uid()))
    )
    and status = 'pending'
    and expires_at > now();
  if not found then
    raise exception 'Home invitation not found.';
  end if;
  return case when accept_invitation then 'accepted' else 'declined' end;
end;
$$;

create or replace function public.cleanup_expired_social_data()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed_count integer;
begin
  delete from public.social_posts
  where (pinned_to_home = false and expires_at <= now())
     or (media_ready = false and created_at < now() - interval '1 hour');
  get diagnostics removed_count = row_count;

  delete from public.home_invitations
  where expires_at <= now() or (status <> 'pending' and created_at < now() - interval '7 days');
  return removed_count;
end;
$$;

create or replace function public.delete_my_account(confirmation text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null or confirmation <> 'DELETE' then
    raise exception 'Account deletion was not confirmed.';
  end if;
  delete from auth.users where id = current_user_id;
end;
$$;

alter table public.user_blocks enable row level security;
alter table public.safety_reports enable row level security;
alter table public.social_posts enable row level security;
alter table public.home_invitations enable row level security;

drop policy if exists "profiles are readable" on public.profiles;
create policy "profiles are visible to social connections"
on public.profiles for select to authenticated
using (
  user_id = (select auth.uid())
  or (
    not public.has_block_between(user_id, (select auth.uid()))
    and exists (
      select 1
      from public.neighbors
      where (user_id = public.profiles.user_id and neighbor_id = (select auth.uid()))
         or (neighbor_id = public.profiles.user_id and user_id = (select auth.uid()))
    )
  )
  or exists (
    select 1
    from public.user_blocks
    where blocker_id = (select auth.uid())
      and blocked_id = public.profiles.user_id
  )
);

drop policy if exists "participants can update neighbor links" on public.neighbors;
drop policy if exists "users can request neighbors" on public.neighbors;
drop policy if exists "participants can delete neighbor links" on public.neighbors;

drop policy if exists "owners can read homes" on public.homes;
create policy "owners and friends can read homes"
on public.homes for select to authenticated
using (public.can_visit_home(owner_id, (select auth.uid())));

create policy "permanent users can create homes"
on public.homes as restrictive for insert to authenticated
with check (public.is_social_ready_user());

create policy "permanent users can update homes"
on public.homes as restrictive for update to authenticated
using (public.is_social_ready_user())
with check (public.is_social_ready_user());

create policy "users can read their own blocks"
on public.user_blocks for select to authenticated
using (blocker_id = (select auth.uid()));

create policy "users can report another player"
on public.safety_reports for insert to authenticated
with check (
  reporter_id = (select auth.uid())
  and reporter_id <> target_id
  and public.is_social_ready_user()
);

create policy "users can read their own reports"
on public.safety_reports for select to authenticated
using (reporter_id = (select auth.uid()));

create policy "friends can read active posts"
on public.social_posts for select to authenticated
using (
  author_id = (select auth.uid())
  or (
    public.are_friends(author_id, (select auth.uid()))
    and media_ready
    and (
      expires_at > now()
      or (pinned_to_home and public.can_visit_home(author_id, (select auth.uid())))
    )
  )
);

create policy "permanent users can create their posts"
on public.social_posts for insert to authenticated
with check (
  author_id = (select auth.uid())
  and public.is_social_ready_user()
);

create policy "authors can update their posts"
on public.social_posts for update to authenticated
using (author_id = (select auth.uid()))
with check (author_id = (select auth.uid()));

create policy "authors can delete their posts"
on public.social_posts for delete to authenticated
using (author_id = (select auth.uid()));

create policy "participants can read home invitations"
on public.home_invitations for select to authenticated
using (host_id = (select auth.uid()) or guest_id = (select auth.uid()));

revoke insert, update, delete on public.neighbors from authenticated;
grant select on public.neighbors to authenticated;
grant select on public.user_blocks to authenticated;
grant select, insert on public.safety_reports to authenticated;
grant select, insert, update, delete on public.social_posts to authenticated;
grant select on public.home_invitations to authenticated;

revoke execute on function public.is_permanent_user() from public, anon;
revoke execute on function public.is_social_ready_user_id(uuid) from public, anon, authenticated;
revoke execute on function public.is_social_ready_user() from public, anon;
revoke execute on function public.has_block_between(uuid, uuid) from public, anon;
revoke execute on function public.are_friends(uuid, uuid) from public, anon;
revoke execute on function public.can_visit_home(uuid, uuid) from public, anon;
revoke execute on function public.send_friend_request(uuid) from public, anon;
revoke execute on function public.respond_friend_request(uuid, boolean) from public, anon;
revoke execute on function public.cancel_friend_request(uuid) from public, anon;
revoke execute on function public.remove_friend(uuid) from public, anon;
revoke execute on function public.block_user(uuid) from public, anon;
revoke execute on function public.unblock_user(uuid) from public, anon;
revoke execute on function public.invite_to_home(uuid) from public, anon;
revoke execute on function public.knock_on_home(uuid) from public, anon;
revoke execute on function public.respond_home_invitation(uuid, boolean) from public, anon;
revoke execute on function public.cleanup_expired_social_data() from public, anon, authenticated;
revoke execute on function public.delete_my_account(text) from public, anon;

grant execute on function public.is_permanent_user() to authenticated;
grant execute on function public.is_social_ready_user() to authenticated;
grant execute on function public.has_block_between(uuid, uuid) to authenticated;
grant execute on function public.are_friends(uuid, uuid) to authenticated;
grant execute on function public.can_visit_home(uuid, uuid) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.invite_to_home(uuid) to authenticated;
grant execute on function public.knock_on_home(uuid) to authenticated;
grant execute on function public.respond_home_invitation(uuid, boolean) to authenticated;
grant execute on function public.delete_my_account(text) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'social_posts'
  ) then
    alter publication supabase_realtime add table public.social_posts;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'neighbors'
  ) then
    alter publication supabase_realtime add table public.neighbors;
  end if;
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'home_invitations'
  ) then
    alter publication supabase_realtime add table public.home_invitations;
  end if;
end;
$$;

select cron.schedule(
  'blockaroo-expired-social-cleanup',
  '*/15 * * * *',
  'select public.cleanup_expired_social_data()'
);
