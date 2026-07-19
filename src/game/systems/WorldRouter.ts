import type { WorldLocation } from "../types/world";

/**
 * The prototype only renders Town Square, but all movement is already scoped
 * to a location. Adding homes, private overworlds, and cities becomes a scene
 * routing problem rather than a database rewrite.
 */
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
