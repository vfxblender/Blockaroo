import type { WorldLocation } from "../types/world";

/** Keeps the active room stable while the user moves between interface tabs. */
export class WorldRouter {
  private location: WorldLocation = {
    cityId: "nashville",
    spaceId: "town-square",
    kind: "town-square",
  };

  current(): WorldLocation {
    return this.location;
  }

  goTo(location: WorldLocation): void {
    this.location = location;
  }
}
