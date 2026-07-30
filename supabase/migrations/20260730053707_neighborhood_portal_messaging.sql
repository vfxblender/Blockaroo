-- Neighborhood messaging and the first four Nashville Portal rooms.
-- Direct messages are durable. The nullable ciphertext fields reserve a
-- backwards-compatible path to client-side encryption without claiming E2EE
-- before device key management exists.

alter table public.spaces
  drop constraint if exists spaces_kind_check,
  add constraint spaces_kind_check
    check (kind in ('town-square', 'overworld', 'house', 'theater', 'room'));

insert into public.spaces (city_id, slug, kind, is_public)
values
  ('nashville', 'film-district', 'room', true),
  ('nashville', 'art-yard', 'room', true),
  ('nashville', 'night-market', 'room', true)
on conflict (city_id, slug) do update
set kind = excluded.kind, is_public = excluded.is_public;

alter table public.social_posts
  drop constraint if exists social_posts_location_label_check,
  add constraint social_posts_location_label_check check (
    location_label is null
    or location_label in (
      'Town Square',
      'Film District',
      'Art Yard',
      'Night Market',
      'Downtown',
      'East Nashville',
      'The Gulch',
      'Centennial Park'
    )
  );

create table public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text,
  ciphertext text,
  encryption_version smallint,
  client_nonce uuid not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (sender_id, client_nonce),
  check (sender_id <> recipient_id),
  check (
    (
      body is not null
      and char_length(trim(body)) between 1 and 2000
      and ciphertext is null
      and encryption_version is null
    )
    or (
      body is null
      and ciphertext is not null
      and char_length(ciphertext) between 1 and 12000
      and encryption_version is not null
      and encryption_version >= 1
    )
  ),
  check (read_at is null or read_at >= created_at)
);

create index direct_messages_sender_thread_index
  on public.direct_messages (sender_id, recipient_id, created_at desc);

create index direct_messages_recipient_thread_index
  on public.direct_messages (recipient_id, sender_id, created_at desc);

create index direct_messages_unread_index
  on public.direct_messages (recipient_id, created_at desc)
  where read_at is null;

alter table public.direct_messages enable row level security;
alter table public.direct_messages replica identity full;

create or replace function public.prepare_direct_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    if current_user_id is null
      or new.sender_id <> current_user_id
      or not public.is_social_ready_user()
    then
      raise exception 'Message sender does not match a permanent, social-ready account.';
    end if;

    if not public.is_social_ready_user_id(new.recipient_id)
      or not public.are_friends(new.sender_id, new.recipient_id)
      or public.has_block_between(new.sender_id, new.recipient_id)
    then
      raise exception 'Direct messages can only be sent between current friends.';
    end if;

    if (
      select count(*)
      from public.direct_messages
      where sender_id = current_user_id
        and created_at > now() - interval '1 minute'
    ) >= 30 or (
      select count(*)
      from public.direct_messages
      where sender_id = current_user_id
        and created_at > now() - interval '24 hours'
    ) >= 2000 then
      raise exception 'Too many messages. Try again later.';
    end if;

    new.created_at := now();
    new.read_at := null;
    return new;
  end if;

  if current_user_id is null or old.recipient_id <> current_user_id then
    raise exception 'Only the recipient can mark a message as read.';
  end if;

  new.id := old.id;
  new.sender_id := old.sender_id;
  new.recipient_id := old.recipient_id;
  new.body := old.body;
  new.ciphertext := old.ciphertext;
  new.encryption_version := old.encryption_version;
  new.client_nonce := old.client_nonce;
  new.created_at := old.created_at;
  new.read_at := coalesce(old.read_at, now());
  return new;
end;
$$;

create trigger direct_messages_prepare
before insert or update on public.direct_messages
for each row execute function public.prepare_direct_message();

create policy "participants can read their direct messages"
on public.direct_messages for select to authenticated
using (
  public.is_social_ready_user()
  and (
    sender_id = (select auth.uid())
    or recipient_id = (select auth.uid())
  )
  and not public.has_block_between(sender_id, recipient_id)
);

create policy "friends can send direct messages"
on public.direct_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and public.is_social_ready_user()
  and public.are_friends(sender_id, recipient_id)
  and not public.has_block_between(sender_id, recipient_id)
);

create policy "recipients can mark direct messages read"
on public.direct_messages for update to authenticated
using (
  recipient_id = (select auth.uid())
  and public.is_social_ready_user()
  and not public.has_block_between(sender_id, recipient_id)
)
with check (
  recipient_id = (select auth.uid())
  and public.is_social_ready_user()
  and not public.has_block_between(sender_id, recipient_id)
);

revoke all on table public.direct_messages from public, anon, authenticated;
grant select on table public.direct_messages to authenticated;
grant insert (sender_id, recipient_id, body, ciphertext, encryption_version, client_nonce)
  on table public.direct_messages to authenticated;
grant update (read_at) on table public.direct_messages to authenticated;

revoke execute on function public.prepare_direct_message() from public, anon, authenticated;

create or replace function public.search_social_profiles(
  search_query text,
  result_limit integer default 20
)
returns table (
  user_id uuid,
  display_name text,
  handle text,
  block_color text,
  profile_photo_path text,
  last_seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_query text :=
    lower(regexp_replace(trim(coalesce(search_query, '')), '[^a-zA-Z0-9_ ]', '', 'g'));
begin
  if not public.is_social_ready_user() or char_length(normalized_query) < 2 then
    return;
  end if;

  return query
  select
    profile.user_id,
    profile.display_name,
    profile.handle,
    profile.block_color,
    profile.profile_photo_path,
    profile.last_seen_at
  from public.profiles as profile
  where profile.user_id <> (select auth.uid())
    and public.is_social_ready_user_id(profile.user_id)
    and not public.has_block_between((select auth.uid()), profile.user_id)
    and (
      position(normalized_query in lower(profile.display_name)) > 0
      or position(normalized_query in lower(coalesce(profile.handle, ''))) > 0
    )
  order by
    case
      when lower(coalesce(profile.handle, '')) = normalized_query then 0
      when lower(profile.display_name) = normalized_query then 1
      else 2
    end,
    lower(profile.display_name),
    profile.user_id
  limit least(greatest(coalesce(result_limit, 20), 1), 20);
end;
$$;

revoke execute on function public.search_social_profiles(text, integer)
  from public, anon;
grant execute on function public.search_social_profiles(text, integer)
  to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'direct_messages'
  ) then
    alter publication supabase_realtime add table public.direct_messages;
  end if;
end;
$$;

drop policy if exists "users can join their private message channel"
  on realtime.messages;
create policy "users can join their private message channel"
on realtime.messages for select to authenticated
using (
  public.is_social_ready_user()
  and (select realtime.topic()) = (
    'direct-messages:' || (select auth.uid())::text
  )
);

-- Trigger functions are invoked by Postgres itself and should not also be
-- callable as public RPCs.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.prepare_social_post() from public, anon, authenticated;
revoke execute on function public.prepare_safety_report() from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
