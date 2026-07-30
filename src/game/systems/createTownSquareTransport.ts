import { RealtimeTownSquare } from "./RealtimeTownSquare";
import type { WorldLocation } from "../types/world";
import type { TownSquareCallbacks, TownSquareTransport } from "./TownSquareTransport";
import { WebSocketTownSquare } from "./WebSocketTownSquare";

export function createTownSquareTransport(
  callbacks: TownSquareCallbacks,
  location: WorldLocation,
): TownSquareTransport {
  const endpoint = (import.meta.env.VITE_WORLD_SOCKET_URL as string | undefined)?.trim();
  return endpoint
    ? new WebSocketTownSquare(endpoint, callbacks, location)
    : new RealtimeTownSquare(callbacks, location);
}
