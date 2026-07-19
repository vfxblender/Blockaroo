import { RealtimeTownSquare } from "./RealtimeTownSquare";
import type { TownSquareCallbacks, TownSquareTransport } from "./TownSquareTransport";
import { WebSocketTownSquare } from "./WebSocketTownSquare";

export function createTownSquareTransport(callbacks: TownSquareCallbacks): TownSquareTransport {
  const endpoint = (import.meta.env.VITE_WORLD_SOCKET_URL as string | undefined)?.trim();
  return endpoint
    ? new WebSocketTownSquare(endpoint, callbacks)
    : new RealtimeTownSquare(callbacks);
}
