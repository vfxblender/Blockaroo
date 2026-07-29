import type { SocialPost, SocialProfile } from "./types";

export const BLOCK_PLANET_PAGE_SIZE = 20;
export const BLOCK_PLANET_DISMISS_THRESHOLD = 88;

export interface BlockPlanetSlot {
  column: number;
  row: number;
}

export type BlockPlanetArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export type BlockPlanetViewerStep =
  | { kind: "post"; postId: string }
  | { kind: "exit" }
  | { kind: "stay" };

// Eight portrait thumbnails surround a permanent center post button. A
// feed-sized batch is dealt into these positions in layers so dismissing a
// thumbnail reveals another without downloading more media.
export const BLOCK_PLANET_SLOTS: readonly BlockPlanetSlot[] = Object.freeze([
  { column: 2, row: 1 },
  { column: 3, row: 1 },
  { column: 3, row: 2 },
  { column: 3, row: 3 },
  { column: 2, row: 3 },
  { column: 1, row: 3 },
  { column: 1, row: 2 },
  { column: 1, row: 1 },
]);

export function isBlockPlanetDismiss(deltaX: number, deltaY: number): boolean {
  return Math.hypot(deltaX, deltaY) >= BLOCK_PLANET_DISMISS_THRESHOLD;
}

export function buildBlockPlanetStacks(
  posts: readonly SocialPost[],
  dismissedPostIds: ReadonlySet<string> = new Set(),
): SocialPost[][] {
  const stacks = BLOCK_PLANET_SLOTS.map(() => [] as SocialPost[]);
  posts.forEach((post, index) => {
    if (dismissedPostIds.has(post.id)) return;
    stacks[index % BLOCK_PLANET_SLOTS.length]!.push(post);
  });
  return stacks;
}

export function nextBlockPlanetSlotIndex(
  currentIndex: number,
  key: BlockPlanetArrowKey,
): number {
  const current = BLOCK_PLANET_SLOTS[currentIndex];
  if (!current) return 0;
  const vector = key === "ArrowUp"
    ? { x: 0, y: -1 }
    : key === "ArrowDown"
      ? { x: 0, y: 1 }
      : key === "ArrowLeft"
        ? { x: -1, y: 0 }
        : { x: 1, y: 0 };

  let bestIndex = currentIndex;
  let bestScore = Number.POSITIVE_INFINITY;
  BLOCK_PLANET_SLOTS.forEach((candidate, index) => {
    if (index === currentIndex) return;
    const deltaX = candidate.column - current.column;
    const deltaY = candidate.row - current.row;
    const forward = (deltaX * vector.x) + (deltaY * vector.y);
    if (forward <= 0) return;
    const perpendicular = Math.abs((deltaX * vector.y) - (deltaY * vector.x));
    const score = (perpendicular * 10) + forward;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export function resolveBlockPlanetViewerStep(
  postIds: readonly string[],
  currentPostId: string,
  direction: -1 | 1,
): BlockPlanetViewerStep {
  const currentIndex = postIds.indexOf(currentPostId);
  if (currentIndex < 0) return { kind: "stay" };
  const nextPostId = postIds[currentIndex + direction];
  if (nextPostId) return { kind: "post", postId: nextPostId };
  return direction > 0 ? { kind: "exit" } : { kind: "stay" };
}

const DEMO_AUTHORS: ReadonlyArray<Pick<SocialProfile, "displayName" | "handle" | "blockColor">> = [
  { displayName: "Maya", handle: "maya_frames", blockColor: "#ff6b6b" },
  { displayName: "Andre", handle: "andreoutside", blockColor: "#ffd166" },
  { displayName: "Nia", handle: "nia_makes", blockColor: "#06d6a0" },
  { displayName: "Theo", handle: "theoafterdark", blockColor: "#4cc9f0" },
  { displayName: "June", handle: "junebug", blockColor: "#a78bfa" },
  { displayName: "Sol", handle: "solsounds", blockColor: "#f896d8" },
  { displayName: "Marcus", handle: "marcusmoves", blockColor: "#90be6d" },
  { displayName: "Imani", handle: "imani_here", blockColor: "#f9844a" },
  { displayName: "Rae", handle: "raewanders", blockColor: "#43aa8b" },
  { displayName: "Dev", handle: "devonblocks", blockColor: "#577590" },
];

const DEMO_MOMENTS = [
  "Rooftop movie tonight. I’m bringing the projector.",
  "Found a tiny record shop hiding behind the coffee place.",
  "Anybody want to test my impossible trivia category?",
  "The sunset over the river looks fake in the best way.",
  "Made a six-second animation that took six stupid hours.",
  "Leaving a sketch by the fountain for whoever finds it.",
  "Coffee walk in twenty minutes. No networking. Just coffee.",
  "This beat finally stopped fighting me.",
  "Come see the weird plant that survived my apartment.",
  "I need one honest opinion on a rough cut.",
  "Pickup basketball at the park if the rain stays away.",
  "Dropped three photos from last night on my wall.",
  "Who knows a good late-night noodle place?",
  "My cat has rejected the new chair. I’ll take it.",
  "Trying a no-phone dinner. Posting this is apparently ironic.",
  "The neighborhood band is rehearsing with the windows open.",
  "Made too much soup again. Bring a container.",
  "I found the cleanest walking route through downtown.",
  "Tiny win: finished the thing I’ve avoided all week.",
  "Someone left chalk planets all over the sidewalk.",
  "Old camera, expired film, surprisingly decent results.",
  "Hosting a four-person card game at eight.",
  "Today’s soundtrack is all bass and bad decisions.",
  "Borrow my ladder before I return it tomorrow.",
  "A dog stole my glove and honestly improved the walk.",
  "The mural by the bridge changed overnight.",
  "Need a voice for one line in a ridiculous short film.",
  "Free desk lamp outside my block. It works.",
  "Finally learned the name of the person at the corner store.",
  "Rain on the fire escape sounds better than my playlist.",
  "Testing a new recipe. The smoke alarm is only mildly involved.",
  "Meet at the fountain if you’re still awake.",
  "Built a tiny shelf and only swore at it twice.",
  "There’s live jazz behind the bookstore right now.",
  "I hid a terrible joke somewhere near Town Square.",
  "First warm night in weeks. Everybody is outside.",
  "Can somebody explain why my basil is taller than me?",
  "I’m trading two movie recommendations for one good book.",
  "The corner bakery has exactly one perfect pastry left.",
  "Leaving this here so tomorrow-me remembers today was good.",
] as const;

export function demoBlockPlanetPage(page: number, now = Date.now()): SocialPost[] {
  const safePage = Math.max(0, Math.floor(page));
  const start = safePage * BLOCK_PLANET_PAGE_SIZE;
  return DEMO_MOMENTS.slice(start, start + BLOCK_PLANET_PAGE_SIZE).map((body, offset) => {
    const index = start + offset;
    const authorSeed = DEMO_AUTHORS[index % DEMO_AUTHORS.length]!;
    const authorId = `demo-neighbor-${(index % DEMO_AUTHORS.length) + 1}`;
    const author = {
      userId: authorId,
      displayName: authorSeed.displayName,
      handle: authorSeed.handle,
      blockColor: authorSeed.blockColor,
      avatarMode: "color",
      bio: "A neighbor in the BlockWall prototype.",
      interests: [],
      profilePhotoPath: null,
      lastSeenAt: new Date(now - (index * 6 * 60_000)).toISOString(),
      termsAcceptedAt: null,
      ageConfirmedAt: null,
      termsVersion: null,
    } as SocialProfile;
    return {
      id: `demo-block-post-${index + 1}`,
      authorId,
      author,
      body,
      mediaPath: null,
      mediaType: null,
      locationLabel: index % 5 === 0 ? "Town Square" : null,
      pinnedToHome: false,
      createdAt: new Date(now - ((index + 1) * 7 * 60_000)).toISOString(),
      expiresAt: new Date(now + ((24 * 60 * 60_000) - (index * 7 * 60_000))).toISOString(),
    };
  });
}

export function hasDemoBlockPlanetPage(page: number): boolean {
  return Math.max(0, Math.floor(page)) * BLOCK_PLANET_PAGE_SIZE < DEMO_MOMENTS.length;
}
