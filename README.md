# Blockaroo

Blockaroo is a tiny shared digital neighborhood. Players move a colored block through one canonical Nashville Town Square, speak through temporary expanding blocks, and share short-lived nearby pictures.

The repository is ready to grow into multiple cities, private homes and overworlds, neighbors, BlockDrops, and theaters without turning each expansion into a networking rewrite.

## What works

- Phaser 3 + TypeScript client deployed by GitHub Pages
- keyboard, virtual joystick, and tap-to-move controls
- keyboard capture disabled and reset while any current text field has focus
- anonymous Supabase identity with local name/color persistence
- black block outlines and smooth remote interpolation
- four deterministic local town guides that consume no network data
- temporary nearby text bubbles and camera-button picture posts
- stateful WebSocket world transport with a working Supabase Realtime fallback
- one logical Town Square with a 1,000-connection room limit
- server-calculated three-zone interest management: 50 detailed, 150 preloaded, everyone else counted only
- private Supabase Storage pictures; WebSockets carry only object paths
- durable Supabase schema for cities, spaces, profiles, homes, neighbors, and BlockDrops

## Runtime split

| Concern | Owner |
|---|---|
| Rendering, input prediction, interpolation | Phaser client |
| Movement, presence, proximity text/photo events | Cloudflare Durable Object WebSocket room |
| Identity and anonymous sessions | Supabase Auth |
| Profiles, cities, homes, neighbors, BlockDrops | Supabase Postgres + RLS |
| Temporary picture bytes | Private Supabase Storage |
| Static site | GitHub Pages |

If `VITE_WORLD_SOCKET_URL` is blank, the client automatically uses the existing Supabase Realtime channel. That makes deployment reversible: the game remains playable before the Worker is configured.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

Build the browser client:

```bash
npm run build
```

Run the stateful world locally in a second terminal:

```bash
cd worker
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

Set `VITE_WORLD_SOCKET_URL=http://localhost:8787` in `.env.local` to use it.

## Deployment

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The short version is:

1. deploy the Supabase migrations and cleanup function;
2. deploy the Cloudflare world Worker;
3. save its origin as the GitHub repository variable `VITE_WORLD_SOCKET_URL`;
4. run the existing `Deploy Blockaroo` Pages workflow.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the packet/zone design and [docs/CAPACITY.md](docs/CAPACITY.md) for realistic scaling limits.
