export type PortalRoomId = "town-square" | "film-district" | "art-yard" | "night-market";
export type PortalRoomKind = "town-square" | "overworld" | "theater";
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOME_SPACE_PATTERN = /^home-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface PortalRoomDefinition {
  id: PortalRoomId;
  cityId: "nashville";
  label: string;
  shortLabel: string;
  kind: PortalRoomKind;
  tagline: string;
  mapX: number;
  mapY: number;
  color: string;
  event: boolean;
}

export const PUBLIC_PORTAL_ROOMS: readonly PortalRoomDefinition[] = Object.freeze([
  {
    id: "town-square",
    cityId: "nashville",
    label: "Town Square",
    shortLabel: "Square",
    kind: "town-square",
    tagline: "The always-open center of Nashville.",
    mapX: 50,
    mapY: 52,
    color: "#ffd166",
    event: false,
  },
  {
    id: "film-district",
    cityId: "nashville",
    label: "Film District",
    shortLabel: "Film",
    kind: "theater",
    tagline: "Rough cuts, screenings, and creative crews.",
    mapX: 27,
    mapY: 32,
    color: "#ff6b6b",
    event: false,
  },
  {
    id: "art-yard",
    cityId: "nashville",
    label: "Art Yard",
    shortLabel: "Art",
    kind: "overworld",
    tagline: "A loose outdoor room for making things.",
    mapX: 73,
    mapY: 34,
    color: "#4cc9f0",
    event: false,
  },
  {
    id: "night-market",
    cityId: "nashville",
    label: "Night Market",
    shortLabel: "Market",
    kind: "overworld",
    tagline: "The rotating event room. Open now.",
    mapX: 66,
    mapY: 73,
    color: "#a78bfa",
    event: true,
  },
]);

export function isPortalRoomId(value: unknown): value is PortalRoomId {
  return PUBLIC_PORTAL_ROOMS.some(room => room.id === value);
}

export function portalRoom(roomId: string): PortalRoomDefinition | null {
  return PUBLIC_PORTAL_ROOMS.find(room => room.id === roomId) ?? null;
}

export function homeSpaceId(ownerId: string): string | null {
  return USER_ID_PATTERN.test(ownerId) ? `home-${ownerId.toLowerCase()}` : null;
}

export function homeOwnerFromSpaceId(spaceId: string): string | null {
  return HOME_SPACE_PATTERN.exec(spaceId)?.[1]?.toLowerCase() ?? null;
}

export function isWorldSpaceId(value: unknown): value is string {
  return typeof value === "string"
    && (isPortalRoomId(value) || homeOwnerFromSpaceId(value) !== null);
}
