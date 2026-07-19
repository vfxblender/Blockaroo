# Blockaroo

A tiny digital neighborhood: walk around a shared Town Square, meet colorful blocks, and eventually travel between private homes, neighborhood overworlds, cities, and community spaces.

## Prototype status

This first playable build intentionally contains only the core interaction:

- a mobile-friendly Town Square
- keyboard and virtual-joystick movement
- a persistent local display name and block color
- tappable demo neighbors

The demo neighbors are local placeholders. Real accounts, presence, chat, houses, neighbors, BlockDrops, and uploads belong to the next milestones.

## Architecture that will scale

Every player state is scoped to a `WorldLocation`:

```ts
{ cityId: "nashville", spaceId: "town-square", kind: "town-square" }
```

Future locations use the same contract, for example `overworld`, `house`, and `theater`. The client routing system is deliberately separate from the Town Square scene. Supabase can later store these locations and use them as Realtime channel keys.

## Run it

```bash
npm install
npm run dev
```

Build a production version with `npm run build`.

## Next implementation milestone

Replace demo neighbors with Supabase Auth and Realtime Presence in the `nashville:town-square` channel. Do not add homes or feeds before that succeeds—the shared-room loop must be fun first.
