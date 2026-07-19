-- Private, short-lived pictures. The image bytes use Storage; the world
-- WebSocket only sends the small object path to nearby players.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'temporary-block-posts',
  'temporary-block-posts',
  false,
  204800,
  array['image/jpeg']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.temporary_media (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  object_path text not null unique check (char_length(object_path) between 38 and 180),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  check (object_path like (owner_id::text || '/%'))
);

create index if not exists temporary_media_expires_at_idx on public.temporary_media (expires_at);
alter table public.temporary_media enable row level security;

create policy "owners can register temporary media"
on public.temporary_media for insert to authenticated
with check (owner_id = (select auth.uid()) and object_path like ((select auth.uid())::text || '/%'));

create policy "owners can read temporary media records"
on public.temporary_media for select to authenticated
using (owner_id = (select auth.uid()));

create policy "owners can delete temporary media records"
on public.temporary_media for delete to authenticated
using (owner_id = (select auth.uid()));

grant select, insert, delete on public.temporary_media to authenticated;

create policy "authenticated users can view temporary pictures"
on storage.objects for select to authenticated
using (bucket_id = 'temporary-block-posts');

create policy "users can upload temporary pictures to their folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'temporary-block-posts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and lower(storage.extension(name)) = 'jpg'
);

create policy "users can delete their temporary pictures"
on storage.objects for delete to authenticated
using (
  bucket_id = 'temporary-block-posts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
