# Deployment

The production `Deploy Blockaroo` workflow applies the Supabase migrations,
deploys the social Worker, and publishes GitHub Pages in that order. A failure
in either backend job leaves the currently published Pages build untouched.
The original Worker remains deployed separately as a rollback target.

## 1. Deploy the Supabase foundation

In GitHub repository **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | a Supabase personal access token |
| `SUPABASE_DB_PASSWORD` | the Blockaroo database password |

The production workflow applies the RLS-backed cities, spaces, profiles, homes,
neighbors, BlockDrops, friends, safety, invitations, and Block Posts schema.
The separate **Deploy Supabase schema** workflow remains available for a
database-only redeploy.

The social migration also enables Supabase Cron and schedules expired post and
invitation cleanup every 15 minutes.

Anonymous sign-ins must remain enabled under **Authentication → Providers → Anonymous**.
Enable manual identity linking so an anonymous player can attach an email to
the same user instead of abandoning their block. Add the GitHub Pages URL and
local development URL to **Authentication → URL Configuration → Redirect URLs**
so confirmation links can return to Blockaroo.

Before a public launch, replace the setup copy with reviewed Terms, minimum-age
language, privacy disclosures, and Community Safety Rules. The database blocks
social features until the current terms version and age confirmation are saved,
but the repository does not invent legal policy for the operator.

The existing prototype already has anonymous authentication. This schema step prepares permanent Blockaroo features, but it does not block the movement WebSocket. To activate only the current Town Square, complete steps 2–4 below.

## 2. Create private temporary-photo storage

In the Cloudflare dashboard, open **Storage & databases → R2 → Create bucket** and create this exact private bucket:

```text
blockaroo-temporary-media
```

Do not enable public access. The Worker binding in `worker/wrangler.jsonc` is the only application path to the bucket. Upload grants expire after 30 seconds, download links expire after 45 seconds, and the Worker's cron removes temporary objects after roughly two minutes. Friends-only Block Post media uses an authenticated `social/` prefix in this same bucket.

## 3. Deploy the stateful world Worker

Create a Cloudflare account and a Workers API token. Add these GitHub Actions secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token allowed to edit Workers |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `WORLD_TICKET_SECRET` | a random value of at least 32 characters |
| `WORLD_MEDIA_SECRET` | a different random value of at least 32 characters |
| `CLOUDFLARE_TURN_KEY_ID` | the Token ID for a Cloudflare Realtime TURN key |
| `CLOUDFLARE_TURN_API_TOKEN` | that TURN key's server-side API token |

The production workflow type-checks, performs a Wrangler dry run, deploys the
Durable Object and R2 binding, and securely stores both HMAC secrets. The
social release uses a separate `blockaroo-world-social` Worker so the original
Worker remains available for rollback. The separate **Deploy world worker**
workflow remains available for a Worker-only redeploy.

The two TURN secrets are a pair: add both or leave both unset. The deployment
workflow now supports a STUN/direct-WebRTC test deployment when they are
absent; add the pair before inviting real users across different networks.

Copy the deployed Worker origin, for example:

```text
https://blockaroo-world.YOUR-SUBDOMAIN.workers.dev
```

Do not include `/world/...` and do not add a trailing slash.

The TURN values are optional for development but required before a real voice
launch. Without them, direct WebRTC still works when the two browsers can reach
each other, but restrictive NAT/firewall combinations cannot fall back to a
relay.

## 4. Deploy GitHub Pages

Push the verified release to `main` or run **Actions → Deploy Blockaroo**. The
workflow publishes Pages only after the schema and social Worker deploy
successfully. The release build points at:

```text
https://blockaroo-world-social.vfxblender.workers.dev
```

## 5. Verify before inviting players

1. Open the Pages URL in two different browser profiles, not two tabs sharing one session.
2. Confirm the badge says `Live · 2 online`.
3. Move each block; remote movement should be smooth between sparse packets.
4. Hold a direction for more than 15 seconds and confirm corrections do not visibly jolt.
5. Focus the name or chat field and type `wasd`; the block must stay still and the letters must appear.
6. Test joystick and tap-to-move on a phone.
7. Send text nearby, then move outside the chat radius and confirm it is not delivered.
8. Send a photo and a sub-256 KB GIF and confirm only nearby players receive them.
9. Wait more than two minutes and confirm the object disappears from the R2 bucket.
10. Link both test players to separate email accounts.
11. Send and accept a friend request, create a text/photo Block Post, and verify only the accepted friend can load its media.
12. Throttle the media upload and confirm the friend does not see the post until the R2 upload finishes.
13. Confirm a normal post disappears after 24 hours and a post pinned to Block Home remains on the home wall.
14. Invite the second player through their avatar, accept, and confirm private voice connects.
15. Test open, ask-to-join, and invite-only Circle modes plus the ten-second one-member shutdown.
16. Minimize the Circle, walk beyond the grace radius, and confirm voice and membership close.
17. Start each of the four games and verify private cards, words, and roles are not visible in the other player's snapshot.
18. Try to join during a game and confirm entry remains locked until the host returns to the game picker.
19. Leave the Circle and confirm its member recap can send a friend request.
20. Delete a disposable test account and confirm its Auth user, posts, home, friendships, and `social/` R2 objects are gone.

## Rollback

Restore `main` from the protected pre-social release branch and rerun its Pages
deployment. That build uses the untouched original Worker. The social database
tables are additive and can remain deployed while the earlier client is live.
