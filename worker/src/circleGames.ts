import type { CircleGame, CircleGameSnapshot } from "../../shared/worldProtocol";

type CardColor = "coral" | "gold" | "mint" | "blue" | "violet" | "wild";

interface GameCard {
  color: CardColor;
  rank: string;
}

interface CardsState {
  kind: "cards";
  phase: "playing" | "finished";
  revision: number;
  players: string[];
  deck: GameCard[];
  hands: Record<string, GameCard[]>;
  discard: GameCard[];
  turnIndex: number;
  direction: 1 | -1;
  winnerId: string | null;
  message: string;
}

interface DrawStroke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

interface DrawState {
  kind: "draw";
  phase: "playing";
  revision: number;
  players: string[];
  round: number;
  artistIndex: number;
  word: string;
  strokes: DrawStroke[];
  scores: Record<string, number>;
  message: string;
}

interface BluffState {
  kind: "bluff";
  phase: "discussion" | "result";
  revision: number;
  players: string[];
  round: number;
  impostorId: string;
  word: string;
  votes: Record<string, string>;
  accusedId: string | null;
  winners: "crew" | "impostor" | null;
  message: string;
}

interface SquarePosition {
  x: number;
  y: number;
  eliminated: boolean;
}

interface SquareOffState {
  kind: "square-off";
  phase: "playing" | "finished";
  revision: number;
  players: string[];
  round: number;
  positions: Record<string, SquarePosition>;
  startedAt: number;
  arenaRadius: number;
  winnerId: string | null;
  message: string;
}

export type StoredCircleGameState = CardsState | DrawState | BluffState | SquareOffState;

export function createCircleGame(game: CircleGame, memberIds: string[]): StoredCircleGameState {
  if (game === "cards") return createCards(memberIds);
  if (game === "draw") return createDraw(memberIds);
  if (game === "bluff") return createBluff(memberIds);
  return createSquareOff(memberIds);
}

export function validateGamePlayers(game: CircleGame, memberCount: number): string | null {
  if (memberCount < 2) return "At least two Circle members are needed.";
  if (game === "bluff" && memberCount < 4) return "Bluff needs at least four players.";
  return null;
}

export function applyCircleGameAction(
  state: StoredCircleGameState,
  actorId: string,
  hostId: string,
  action: string,
  payload: unknown,
): string | null {
  const error = state.kind === "cards"
    ? applyCardsAction(state, actorId, action, payload)
    : state.kind === "draw"
      ? applyDrawAction(state, actorId, hostId, action, payload)
      : state.kind === "bluff"
        ? applyBluffAction(state, actorId, hostId, action, payload)
        : applySquareOffAction(state, actorId, hostId, action, payload);
  if (!error) state.revision += 1;
  return error;
}

export function circleGameSnapshot(state: StoredCircleGameState, viewerId: string, drawingDelta = false): CircleGameSnapshot {
  if (state.kind === "cards") {
    return {
      game: "cards",
      phase: state.phase,
      revision: state.revision,
      publicState: {
        players: state.players,
        topCard: state.discard.at(-1) ?? null,
        handCounts: Object.fromEntries(state.players.map(id => [id, state.hands[id]?.length ?? 0])),
        currentPlayerId: state.players[state.turnIndex] ?? null,
        direction: state.direction,
        winnerId: state.winnerId,
        message: state.message,
      },
      privateState: { hand: state.hands[viewerId] ?? [], isSpectator: !state.players.includes(viewerId) },
    };
  }
  if (state.kind === "draw") {
    const artistId = state.players[state.artistIndex] ?? "";
    return {
      game: "draw",
      phase: state.phase,
      revision: state.revision,
      publicState: {
        players: state.players,
        artistId,
        maskedWord: state.word.replace(/[a-z0-9]/gi, "_"),
        strokes: drawingDelta ? state.strokes.slice(-1) : state.strokes,
        strokeDelta: drawingDelta,
        scores: state.scores,
        round: state.round,
        message: state.message,
      },
      privateState: artistId === viewerId ? { word: state.word, isArtist: true } : { isArtist: false },
    };
  }
  if (state.kind === "bluff") {
    return {
      game: "bluff",
      phase: state.phase,
      revision: state.revision,
      publicState: {
        players: state.players,
        round: state.round,
        voteCount: Object.keys(state.votes).length,
        accusedId: state.accusedId,
        winners: state.winners,
        revealedImpostorId: state.phase === "result" ? state.impostorId : null,
        revealedWord: state.phase === "result" ? state.word : null,
        message: state.message,
      },
      privateState: state.impostorId === viewerId
        ? { role: "impostor", word: null }
        : { role: "crew", word: state.word },
    };
  }
  return {
    game: "square-off",
    phase: state.phase,
    revision: state.revision,
    publicState: {
      players: state.players,
      positions: state.positions,
      arenaRadius: state.arenaRadius,
      startedAt: state.startedAt,
      winnerId: state.winnerId,
      round: state.round,
      message: state.message,
    },
    privateState: { isSpectator: !state.players.includes(viewerId) },
  };
}

export function circleGameLabel(game: CircleGame | null): string {
  if (game === "cards") return "Crazy Blocks";
  if (game === "draw") return "Draw & Guess";
  if (game === "bluff") return "Bluff / Impostor";
  if (game === "square-off") return "Square-Off";
  return "Talking";
}

function createCards(memberIds: string[]): CardsState {
  const players = memberIds.slice(0, 6);
  const deck = shuffledCardDeck();
  const hands: Record<string, GameCard[]> = Object.fromEntries(players.map(id => [id, []]));
  for (let cardIndex = 0; cardIndex < 5; cardIndex += 1) {
    for (const playerId of players) {
      const card = deck.pop();
      if (card) hands[playerId].push(card);
    }
  }
  const firstCard = deck.pop() ?? { color: "wild", rank: "wild" };
  return {
    kind: "cards",
    phase: "playing",
    revision: 1,
    players,
    deck,
    hands,
    discard: [firstCard],
    turnIndex: 0,
    direction: 1,
    winnerId: null,
    message: `${shortId(players[0])} plays first.`,
  };
}

function applyCardsAction(state: CardsState, actorId: string, action: string, payload: unknown): string | null {
  if (state.phase !== "playing") return "This round is over.";
  if (state.players[state.turnIndex] !== actorId) return "Wait for your turn.";
  if (action === "draw") {
    const card = drawCard(state);
    if (card) state.hands[actorId].push(card);
    state.message = `${shortId(actorId)} drew a card.`;
    advanceCardTurn(state, 1);
    return null;
  }
  if (action !== "play") return "That card action is not supported.";
  const index = integerField(payload, "index");
  const hand = state.hands[actorId];
  if (index === null || index < 0 || index >= hand.length) return "Choose a card in your hand.";
  const card = hand[index];
  const top = state.discard.at(-1);
  if (top && card.color !== "wild" && top.color !== "wild" && card.color !== top.color && card.rank !== top.rank) {
    return "Match the color or symbol.";
  }
  hand.splice(index, 1);
  state.discard.push(card);
  if (!hand.length) {
    state.phase = "finished";
    state.winnerId = actorId;
    state.message = `${shortId(actorId)} wins Crazy Blocks.`;
    return null;
  }
  if (card.rank === "reverse" && state.players.length > 2) state.direction = state.direction === 1 ? -1 : 1;
  const steps = card.rank === "skip" ? 2 : 1;
  state.message = `${shortId(actorId)} played ${card.color} ${card.rank}.`;
  advanceCardTurn(state, steps);
  return null;
}

function advanceCardTurn(state: CardsState, steps: number): void {
  const count = state.players.length;
  state.turnIndex = ((state.turnIndex + state.direction * steps) % count + count) % count;
}

function drawCard(state: CardsState): GameCard | null {
  if (!state.deck.length && state.discard.length > 1) {
    const top = state.discard.pop()!;
    state.deck = shuffle(state.discard.splice(0));
    state.discard.push(top);
  }
  return state.deck.pop() ?? null;
}

function shuffledCardDeck(): GameCard[] {
  const colors: CardColor[] = ["coral", "gold", "mint", "blue", "violet"];
  const deck: GameCard[] = [];
  for (const color of colors) {
    for (let rank = 1; rank <= 9; rank += 1) deck.push({ color, rank: String(rank) });
    deck.push({ color, rank: "skip" }, { color, rank: "reverse" });
  }
  for (let index = 0; index < 5; index += 1) deck.push({ color: "wild", rank: "wild" });
  return shuffle(deck);
}

function createDraw(memberIds: string[]): DrawState {
  const players = memberIds.slice(0, 6);
  return {
    kind: "draw",
    phase: "playing",
    revision: 1,
    players,
    round: 1,
    artistIndex: 0,
    word: randomItem(DRAW_WORDS),
    strokes: [],
    scores: Object.fromEntries(players.map(id => [id, 0])),
    message: `${shortId(players[0])} is drawing.`,
  };
}

function applyDrawAction(state: DrawState, actorId: string, hostId: string, action: string, payload: unknown): string | null {
  const artistId = state.players[state.artistIndex];
  if (action === "stroke") {
    if (actorId !== artistId) return "Only the artist can draw.";
    const stroke = validStroke(payload);
    if (!stroke) return "That drawing stroke is invalid.";
    if (state.strokes.length >= 1_200) return "The canvas is full. Clear it or skip.";
    state.strokes.push(stroke);
    return null;
  }
  if (action === "clear") {
    if (actorId !== artistId) return "Only the artist can clear the canvas.";
    state.strokes = [];
    state.message = `${shortId(actorId)} cleared the canvas.`;
    return null;
  }
  if (action === "skip") {
    if (actorId !== artistId && actorId !== hostId) return "Only the artist or host can skip.";
    rotateArtist(state, "Word skipped.");
    return null;
  }
  if (action !== "guess") return "That drawing action is not supported.";
  if (actorId === artistId) return "The artist cannot guess.";
  const guess = stringField(payload, "guess", 60).toLowerCase();
  if (!guess) return "Type a guess.";
  if (normalizeGuess(guess) !== normalizeGuess(state.word)) {
    state.message = `${shortId(actorId)} guessed “${guess}”.`;
    return null;
  }
  state.scores[actorId] = (state.scores[actorId] ?? 0) + 2;
  state.scores[artistId] = (state.scores[artistId] ?? 0) + 1;
  rotateArtist(state, `${shortId(actorId)} got it: ${state.word}!`);
  return null;
}

function rotateArtist(state: DrawState, message: string): void {
  state.artistIndex = (state.artistIndex + 1) % state.players.length;
  state.round += 1;
  state.word = randomItem(DRAW_WORDS);
  state.strokes = [];
  state.message = `${message} ${shortId(state.players[state.artistIndex])} draws next.`;
}

function createBluff(memberIds: string[], round = 1): BluffState {
  const players = memberIds.slice(0, 6);
  return {
    kind: "bluff",
    phase: "discussion",
    revision: 1,
    players,
    round,
    impostorId: randomItem(players),
    word: randomItem(BLUFF_WORDS),
    votes: {},
    accusedId: null,
    winners: null,
    message: "Describe your word without giving it away, then vote.",
  };
}

function applyBluffAction(state: BluffState, actorId: string, hostId: string, action: string, payload: unknown): string | null {
  if (action === "next") {
    if (actorId !== hostId) return "Only the host can start the next round.";
    const next = createBluff(state.players, state.round + 1);
    Object.assign(state, next, { revision: state.revision });
    return null;
  }
  if (state.phase !== "discussion" || action !== "vote") return "Voting is closed.";
  if (!state.players.includes(actorId)) return "Spectators cannot vote.";
  const targetId = stringField(payload, "targetId", 64);
  if (!state.players.includes(targetId) || targetId === actorId) return "Choose another player.";
  state.votes[actorId] = targetId;
  state.message = `${Object.keys(state.votes).length}/${state.players.length} votes are in.`;
  if (Object.keys(state.votes).length < state.players.length) return null;

  const totals = new Map<string, number>();
  for (const vote of Object.values(state.votes)) totals.set(vote, (totals.get(vote) ?? 0) + 1);
  const ranked = [...totals.entries()].sort((left, right) => right[1] - left[1]);
  const accusedId = ranked[0]?.[0] ?? null;
  const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  state.phase = "result";
  state.accusedId = tied ? null : accusedId;
  state.winners = !tied && accusedId === state.impostorId ? "crew" : "impostor";
  state.message = tied
    ? `The vote tied. The impostor escapes. The word was “${state.word}”.`
    : state.winners === "crew"
      ? `The crew caught ${shortId(state.impostorId)}. The word was “${state.word}”.`
      : `${shortId(state.impostorId)} fooled the Circle. The word was “${state.word}”.`;
  return null;
}

function createSquareOff(memberIds: string[], round = 1): SquareOffState {
  const players = memberIds.slice(0, 4);
  const positions: Record<string, SquarePosition> = {};
  players.forEach((id, index) => {
    const angle = (index / players.length) * Math.PI * 2 - Math.PI / 2;
    positions[id] = { x: Math.cos(angle) * 0.55, y: Math.sin(angle) * 0.55, eliminated: false };
  });
  return {
    kind: "square-off",
    phase: "playing",
    revision: 1,
    players,
    round,
    positions,
    startedAt: Date.now(),
    arenaRadius: 1,
    winnerId: null,
    message: "Move, bump rivals, and stay inside the shrinking arena.",
  };
}

function applySquareOffAction(
  state: SquareOffState,
  actorId: string,
  hostId: string,
  action: string,
  payload: unknown,
): string | null {
  if (action === "restart") {
    if (actorId !== hostId) return "Only the host can restart Square-Off.";
    const next = createSquareOff(state.players, state.round + 1);
    Object.assign(state, next, { revision: state.revision });
    return null;
  }
  if (state.phase !== "playing" || action !== "move") return "This Square-Off round is over.";
  const player = state.positions[actorId];
  if (!player || player.eliminated) return "You are spectating this round.";
  const dx = numberField(payload, "dx");
  const dy = numberField(payload, "dy");
  if (dx === null || dy === null) return "That move is invalid.";
  const length = Math.hypot(dx, dy);
  if (length < 0.05) return null;
  const directionX = dx / length;
  const directionY = dy / length;
  player.x += directionX * 0.065;
  player.y += directionY * 0.065;

  for (const otherId of state.players) {
    if (otherId === actorId) continue;
    const other = state.positions[otherId];
    if (!other || other.eliminated) continue;
    const deltaX = other.x - player.x;
    const deltaY = other.y - player.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance < 0.16) {
      const pushX = distance > 0.001 ? deltaX / distance : directionX;
      const pushY = distance > 0.001 ? deltaY / distance : directionY;
      other.x += pushX * 0.105;
      other.y += pushY * 0.105;
      player.x -= pushX * 0.025;
      player.y -= pushY * 0.025;
    }
  }

  state.arenaRadius = Math.max(0.38, 1 - ((Date.now() - state.startedAt) / 90_000) * 0.62);
  for (const id of state.players) {
    const position = state.positions[id];
    if (!position.eliminated && Math.hypot(position.x, position.y) > state.arenaRadius) {
      position.eliminated = true;
      state.message = `${shortId(id)} fell out.`;
    }
  }
  const survivors = state.players.filter(id => !state.positions[id].eliminated);
  if (survivors.length <= 1) {
    state.phase = "finished";
    state.winnerId = survivors[0] ?? null;
    state.message = state.winnerId ? `${shortId(state.winnerId)} wins Square-Off.` : "Everybody fell out.";
  }
  return null;
}

function validStroke(payload: unknown): DrawStroke | null {
  const x1 = numberField(payload, "x1");
  const y1 = numberField(payload, "y1");
  const x2 = numberField(payload, "x2");
  const y2 = numberField(payload, "y2");
  const width = numberField(payload, "width");
  const color = stringField(payload, "color", 12);
  if ([x1, y1, x2, y2, width].some(value => value === null)) return null;
  if (x1! < 0 || x1! > 1 || y1! < 0 || y1! > 1 || x2! < 0 || x2! > 1 || y2! < 0 || y2! > 1) return null;
  if (width! < 1 || width! > 18 || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  return { x1: x1!, y1: y1!, x2: x2!, y2: y2!, width: width!, color };
}

function stringField(payload: unknown, key: string, maxLength: number): string {
  if (!payload || typeof payload !== "object") return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function numberField(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerField(payload: unknown, key: string): number | null {
  const value = numberField(payload, key);
  return value !== null && Number.isInteger(value) ? value : null;
}

function normalizeGuess(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function randomItem<T>(items: T[]): T {
  return items[randomIndex(items.length)]!;
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function randomIndex(length: number): number {
  if (length <= 1) return 0;
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % length;
}

function shortId(id: string | undefined): string {
  return id ? `Player ${id.slice(0, 4)}` : "A player";
}

const DRAW_WORDS = [
  "guitar", "hot chicken", "cowboy hat", "river", "moon", "camera",
  "coffee", "roller skate", "alien", "microphone", "bridge", "tornado",
];

const BLUFF_WORDS = [
  "honky tonk", "spaceship", "pancakes", "record player", "campfire",
  "waterfall", "movie theater", "tattoo", "rooftop", "thunderstorm",
];
