# Capacity and data budget

The design is optimized for sparse changes, not a promise that 1,000 continuously active players will be free on every provider. The hard room limit is 1,000 connections; production capacity still needs a load test using the intended Cloudflare and Supabase plans.

## Raw protocol payloads

| Payload | Size before WebSocket/TLS overhead |
|---|---:|
| movement instruction | 8 bytes |
| state batch header | 8 bytes |
| one state record | 14 bytes |
| maximum 50-player detailed correction | 708 bytes |

The browser sends on direction changes and once every three seconds while continuously moving. It does not send 10–20 coordinate messages per second. A stationary player creates no movement heartbeat. The room sends a velocity update when the instruction changes and lets receivers predict between updates.

Actual transfer is higher than the table because WebSocket frames, TCP/IP, TLS, JSON control messages, retries, and provider accounting add overhead. Direction-change rate and local crowd density matter far more than the total online count.

## What scales well

- 1,000 connected players who are mostly idle
- many players distributed over a larger map
- short movement bursts with few direction changes
- local AI simulated deterministically in each browser
- text messages limited by proximity and rate limits

## What can still become expensive

- all 1,000 players changing direction continuously
- showing every movement to every other player (intentionally not supported)
- photos shared frequently; even a 100 KB photo dwarfs movement packets
- join/leave storms
- a map so dense that everyone competes for the nearest 200 slots

## Guardrails already present

- maximum 50 detailed and 150 preloaded remote players per viewer
- zone 3 is count-only
- one text message per 900 ms and one photo per 12 seconds per connection
- 120-character live text limit
- private JPEG-only bucket capped at 200 KB per object
- client processing targets roughly 100 KB or less per picture
- authoritative world bounds, sequence checks, ticket expiry, origin allowlist, and duplicate-session replacement

Before advertising a 1,000-player event, run staged tests at 50, 200, 500, and 1,000 connections and measure Durable Object CPU, requests, WebSocket messages, egress, disconnects, and browser frame rate. If one state owner reaches CPU limits, the next step is invisible cell workers behind the same Town Square address—not visible duplicate communities.
