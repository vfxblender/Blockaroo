# Deployment

The GitHub Pages site is already able to run in Supabase fallback mode. Enable the new architecture in this order so there is always a working rollback.

## 1. Deploy the Supabase foundation

In GitHub repository **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | a Supabase personal access token |
| `SUPABASE_DB_PASSWORD` | the Blockaroo database password |
| `SUPABASE_CLEANUP_SECRET` | a new long random value |

Open **Actions → Deploy Supabase schema → Run workflow**. This applies the RLS migrations, creates the private photo bucket, and deploys `cleanup-temporary-media`.

Then open `supabase/setup_cleanup_cron.sql.example`, replace its placeholder with the same cleanup secret, and run it once in Supabase SQL Editor. Supabase recommends `pg_cron` + `pg_net` with secrets held in Vault for scheduled Edge Functions: <https://supabase.com/docs/guides/functions/schedule-functions>.

Anonymous sign-ins must remain enabled under **Authentication → Providers → Anonymous**.

## 2. Deploy the stateful world Worker

Create a Cloudflare account and a Workers API token. Add these GitHub Actions secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token allowed to edit Workers |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `WORLD_TICKET_SECRET` | another random value of at least 32 characters |

Open **Actions → Deploy world worker → Run workflow**. The workflow type-checks, performs a Wrangler dry run, deploys the Durable Object, and securely stores `TICKET_SECRET` as a Worker secret.

Copy the deployed Worker origin, for example:

```text
https://blockaroo-world.YOUR-SUBDOMAIN.workers.dev
```

Do not include `/world/...` and do not add a trailing slash.

## 3. Point GitHub Pages at the Worker

In GitHub repository **Settings → Secrets and variables → Actions → Variables**, create:

```text
VITE_WORLD_SOCKET_URL=https://blockaroo-world.YOUR-SUBDOMAIN.workers.dev
```

Open **Actions → Deploy Blockaroo → Run workflow**. The next Pages build switches from Supabase Realtime fallback to the world socket automatically.

## 4. Verify before inviting players

1. Open the Pages URL in two different browser profiles, not two tabs sharing one session.
2. Confirm the badge says `Live · 2 online`.
3. Move each block; remote movement should be smooth between sparse packets.
4. Hold a direction for more than 15 seconds and confirm corrections do not visibly jolt.
5. Focus the name or chat field and type `wasd`; the block must stay still and the letters must appear.
6. Test joystick and tap-to-move on a phone.
7. Send text nearby, then move outside the chat radius and confirm it is not delivered.
8. Send a photo and confirm it disappears and its `temporary_media` row is cleaned up.

## Rollback

Delete or blank the repository variable `VITE_WORLD_SOCKET_URL`, then rerun **Deploy Blockaroo**. No database rollback is needed; the browser returns to the existing Supabase Realtime transport.
