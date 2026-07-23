# Blockaroo

Blockaroo is a tiny shared digital neighborhood. Players move a colored block through one canonical Nashville Town Square, speak through temporary expanding blocks, share short-lived nearby pictures, and use their avatar as a portal into a friends-only social layer.

The repository is ready to grow into multiple cities, private homes and overworlds, neighbors, BlockDrops, and theaters without turning each expansion into a networking rewrite.

## What works

- Phaser 3 + TypeScript client deployed by GitHub Pages
- keyboard, virtual joystick, and tap-to-move controls
- keyboard capture disabled and reset while any current text field has focus
- anonymous Supabase identity with local name/color persistence
- black block outlines and smooth remote interpolation
- four deterministic local town guides that consume no network data
- temporary nearby text bubbles and account-gated picture/GIF posts
- one-tap nearby chat with picture and emoji controls plus a separate avatar portal badge
- email-linked accounts that preserve an anonymous player's existing block
- friend requests, blocking, muting, reporting, and home invitations
- friend-request cancellation, unfriend/unblock controls, sign-out, and full account deletion
- chronological friends-only Block Posts that expire after 24 hours, load in 20-post pages, and lazy-load media
- authenticated R2 photo/GIF posts, persistent pinned Block Home memories, and a broad-location Nashville social map
- private six-person Circles joined through nearby player avatars, with an enforced movement grace radius
- WebRTC mesh voice with short-lived Cloudflare TURN credentials
- four server-authoritative Circle games: Crazy Blocks, Draw & Guess, Bluff / Impostor, and Square-Off
- post-Circle connection recaps for sending friend requests without creating permanent group channels
- stateful WebSocket world transport with a working Supabase Realtime fallback
- one logical Town Square with a 1,000-connection room limit
- server-calculated three-zone interest management: 50 detailed, 150 preloaded, everyone else counted only
- private, short-lived Cloudflare R2 pictures authorized through the world socket
- durable Supabase schema for cities, spaces, profiles, homes, neighbors, and BlockDrops

## Runtime split

| Concern | Owner |
|---|---|
| Rendering, input prediction, interpolation | Phaser client |
| Movement, presence, proximity text/photo events | Cloudflare Durable Object WebSocket room |
| Identity, anonymous-to-email upgrades | Supabase Auth |
| Profiles, friends, posts, homes, invitations, reports, expiry jobs | Supabase Postgres + RLS + Cron |
| Temporary and authenticated social media | Private Cloudflare R2 bucket |
| Circle membership, signaling, private game state | Cloudflare Durable Object |
| Circle microphone audio | Browser-to-browser WebRTC with TURN fallback |
| Static site | GitHub Pages |

If `VITE_WORLD_SOCKET_URL` is blank, the client automatically uses the existing Supabase Realtime channel. That makes deployment reversible: the game remains playable before the Worker is configured.

## Local development

```bash
cp .env.example .env.local
npm install
```

For the full social/Circle test path, set this in `.env.local`:

```bash
VITE_WORLD_SOCKET_URL=http://127.0.0.1:8787
```

Then start the two processes in separate terminals:

```bash
# Terminal 1
npm run worker:dev

# Terminal 2
npm run dev
```

On a fresh checkout, copy `worker/.dev.vars.example` to
`worker/.dev.vars` and replace both local HMAC placeholders first. TURN is
optional for same-machine testing.

Run the complete repository check before handing a build to testers:

```bash
npm run check
```

## Deployment

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The short version is:

1. deploy the durable Supabase schema;
2. create the private Cloudflare R2 bucket;
3. deploy the Cloudflare world Worker;
4. save its origin as the GitHub repository variable `VITE_WORLD_SOCKET_URL`;
5. run the existing `Deploy Blockaroo` Pages workflow.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the packet/zone design and [docs/CAPACITY.md](docs/CAPACITY.md) for realistic scaling limits.
