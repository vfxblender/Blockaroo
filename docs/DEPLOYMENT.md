# Deployment

The GitHub Pages site is already able to run in Supabase fallback mode. Enable the new architecture in this order so there is always a working rollback.

## 1. Deploy the Supabase foundation

In GitHub repository **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | a Supabase personal access token |
| `SUPABASE_DB_PASSWORD` | the Blockaroo database password |

Open **Actions → Deploy Supabase schema → Run workflow**. This applies the RLS-backed cities, spaces, profiles, homes, neighbors, and BlockDrops foundation. Movement, live messages, and temporary pictures do not use these tables.

Anonymous sign-ins must remain enabled under **Authentication → Providers → Anonymous**.

The existing prototype already has anonymous authentication. This schema step prepares permanent Blockaroo features, but it does not block the movement WebSocket. To activate only the current Town Square, complete steps 2–4 below.

## 2. Create private temporary-photo storage

In the Cloudflare dashboard, open **Storage & databases → R2 → Create bucket** and create this exact private bucket:

```text
blockaroo-temporary-media
```

Do not enable public access. The Worker binding in `worker/wrangler.jsonc` is the only application path to the bucket. Upload grants expire after 30 seconds, download links expire after 45 seconds, and the Worker's cron removes objects after roughly two minutes.

## 3. Deploy the stateful world Worker

Create a Cloudflare account and a Workers API token. Add these GitHub Actions secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token allowed to edit Workers |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `WORLD_TICKET_SECRET` | a random value of at least 32 characters |
| `WORLD_MEDIA_SECRET` | a different random value of at least 32 characters |

Open **Actions → Deploy world worker → Run workflow**. The workflow type-checks, performs a Wrangler dry run, deploys the Durable Object and R2 binding, and securely stores both HMAC secrets.

Copy the deployed Worker origin, for example:

```text
https://blockaroo-world.YOUR-SUBDOMAIN.workers.dev
```

Do not include `/world/...` and do not add a trailing slash.

## 4. Point GitHub Pages at the Worker

In GitHub repository **Settings → Secrets and variables → Actions → Variables**, create:

```text
VITE_WORLD_SOCKET_URL=https://blockaroo-world.YOUR-SUBDOMAIN.workers.dev
```

Open **Actions → Deploy Blockaroo → Run workflow**. The next Pages build switches from Supabase Realtime fallback to the world socket automatically.

## 5. Verify before inviting players

1. Open the Pages URL in two different browser profiles, not two tabs sharing one session.
2. Confirm the badge says `Live · 2 online`.
3. Move each block; remote movement should be smooth between sparse packets.
4. Hold a direction for more than 15 seconds and confirm corrections do not visibly jolt.
5. Focus the name or chat field and type `wasd`; the block must stay still and the letters must appear.
6. Test joystick and tap-to-move on a phone.
7. Send text nearby, then move outside the chat radius and confirm it is not delivered.
8. Send a photo and confirm only nearby players receive it.
9. Wait more than two minutes and confirm the object disappears from the R2 bucket.

## Rollback

Delete or blank the repository variable `VITE_WORLD_SOCKET_URL`, then rerun **Deploy Blockaroo**. The browser returns to the existing Supabase Realtime movement/text transport, but temporary photo delivery remains disabled so rollback cannot consume Supabase image bandwidth.
