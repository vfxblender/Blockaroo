export const HOME_FURNITURE_KINDS = [
  "rug",
  "sofa",
  "coffee-table",
  "armchair",
  "tv",
  "floor-lamp",
  "plant",
  "bookshelf",
] as const;

export type HomeFurnitureKind = typeof HOME_FURNITURE_KINDS[number];
export type HomeLighting = "day" | "warm" | "night";

export interface HomeFurniture {
  id: string;
  kind: HomeFurnitureKind;
  x: number;
  y: number;
  rotation: number;
  color: string;
}

export interface HomeInteriorLayout {
  version: 1;
  wallColor: string;
  floorColor: string;
  lighting: HomeLighting;
  furniture: HomeFurniture[];
}

export interface HomeFurnitureCatalogItem {
  kind: HomeFurnitureKind;
  label: string;
  color: string;
}

export const HOME_FURNITURE_CATALOG: readonly HomeFurnitureCatalogItem[] = [
  { kind: "sofa", label: "Sofa", color: "#ff6b6b" },
  { kind: "armchair", label: "Chair", color: "#4cc9f0" },
  { kind: "coffee-table", label: "Table", color: "#9a6b42" },
  { kind: "tv", label: "TV", color: "#273247" },
  { kind: "floor-lamp", label: "Lamp", color: "#ffd166" },
  { kind: "rug", label: "Rug", color: "#8e9bd4" },
  { kind: "plant", label: "Plant", color: "#3e8c72" },
  { kind: "bookshelf", label: "Bookshelf", color: "#c78a52" },
] as const;

const DEFAULT_FURNITURE: readonly HomeFurniture[] = [
  { id: "rug-1", kind: "rug", x: 47, y: 73, rotation: 0, color: "#8e9bd4" },
  { id: "sofa-1", kind: "sofa", x: 31, y: 72, rotation: 0, color: "#ff6b6b" },
  { id: "table-1", kind: "coffee-table", x: 51, y: 71, rotation: 0, color: "#9a6b42" },
  { id: "chair-1", kind: "armchair", x: 69, y: 72, rotation: 0, color: "#4cc9f0" },
  { id: "tv-1", kind: "tv", x: 70, y: 44, rotation: 0, color: "#273247" },
  { id: "lamp-1", kind: "floor-lamp", x: 15, y: 53, rotation: 0, color: "#ffd166" },
  { id: "plant-1", kind: "plant", x: 84, y: 54, rotation: 0, color: "#3e8c72" },
  { id: "bookshelf-1", kind: "bookshelf", x: 28, y: 43, rotation: 0, color: "#c78a52" },
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const furnitureKinds = new Set<string>(HOME_FURNITURE_KINDS);

export function defaultHomeInterior(sofaColor = "#ff6b6b"): HomeInteriorLayout {
  const safeSofaColor = cleanHomeColor(sofaColor, "#ff6b6b");
  return {
    version: 1,
    wallColor: "#f3dfbd",
    floorColor: "#d2aa78",
    lighting: "warm",
    furniture: DEFAULT_FURNITURE.map(item => ({
      ...item,
      color: item.kind === "sofa" ? safeSofaColor : item.color,
    })),
  };
}

export function cloneHomeInterior(layout: HomeInteriorLayout): HomeInteriorLayout {
  return {
    ...layout,
    furniture: layout.furniture.map(item => ({ ...item })),
  };
}

export function normalizeHomeInterior(
  value: unknown,
  sofaColor = "#ff6b6b",
): HomeInteriorLayout {
  const fallback = defaultHomeInterior(sofaColor);
  if (!isRecord(value)) return fallback;

  const rawFurniture = Array.isArray(value.furniture) ? value.furniture : null;
  const furniture = rawFurniture
    ? rawFurniture.slice(0, 24).flatMap((item, index) => {
      const normalized = normalizeFurniture(item, index);
      return normalized ? [normalized] : [];
    })
    : fallback.furniture;

  return {
    version: 1,
    wallColor: cleanHomeColor(value.wallColor, fallback.wallColor),
    floorColor: cleanHomeColor(value.floorColor, fallback.floorColor),
    lighting: isHomeLighting(value.lighting) ? value.lighting : fallback.lighting,
    furniture: uniqueFurniture(furniture),
  };
}

export function createHomeFurniture(
  kind: HomeFurnitureKind,
  sequence: number,
): HomeFurniture {
  const catalog = HOME_FURNITURE_CATALOG.find(item => item.kind === kind)!;
  const wallMounted = kind === "tv" || kind === "bookshelf";
  return {
    id: `${kind}-${Date.now().toString(36)}-${Math.max(1, sequence).toString(36)}`,
    kind,
    x: 50,
    y: wallMounted ? 43 : 68,
    rotation: 0,
    color: catalog.color,
  };
}

export function cleanHomeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value)
    ? value.toLowerCase()
    : fallback.toLowerCase();
}

export function clampHomeCoordinate(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.round(Math.min(maximum, Math.max(minimum, value)) * 10) / 10;
}

export function furnitureLabel(kind: HomeFurnitureKind): string {
  return HOME_FURNITURE_CATALOG.find(item => item.kind === kind)?.label ?? "Furniture";
}

function normalizeFurniture(value: unknown, index: number): HomeFurniture | null {
  if (!isRecord(value) || typeof value.kind !== "string" || !furnitureKinds.has(value.kind)) return null;
  const kind = value.kind as HomeFurnitureKind;
  const catalog = HOME_FURNITURE_CATALOG.find(item => item.kind === kind)!;
  const id = typeof value.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(value.id)
    ? value.id
    : `${kind}-${index + 1}`;
  const rotationValue = typeof value.rotation === "number" ? value.rotation : 0;
  const rotation = ((Math.round(rotationValue / 45) * 45) % 360 + 360) % 360;
  return {
    id,
    kind,
    x: clampHomeCoordinate(typeof value.x === "number" ? value.x : 50, 5, 95),
    y: clampHomeCoordinate(typeof value.y === "number" ? value.y : 65, 20, 90),
    rotation,
    color: cleanHomeColor(value.color, catalog.color),
  };
}

function uniqueFurniture(items: HomeFurniture[]): HomeFurniture[] {
  const usedIds = new Set<string>();
  return items.map((item, index) => {
    let id = item.id;
    while (usedIds.has(id)) id = `${item.kind}-${index + 1}-${usedIds.size + 1}`;
    usedIds.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

function isHomeLighting(value: unknown): value is HomeLighting {
  return value === "day" || value === "warm" || value === "night";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
