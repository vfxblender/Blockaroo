export type CityId = "nashville";
export type SpaceKind = "town-square" | "overworld" | "house" | "theater";

export interface WorldLocation {
  cityId: CityId;
  spaceId: string;
  kind: SpaceKind;
}

export interface PlayerIdentity {
  id: string;
  username: string;
  color: string;
}

export interface PlayerState extends PlayerIdentity {
  x: number;
  y: number;
  location: WorldLocation;
}
