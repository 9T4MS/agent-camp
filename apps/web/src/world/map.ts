/**
 * The office map: a hand-written tile grid (one char per 16 px tile) plus a list of
 * furniture objects, named areas and points of interest. Pure data + helpers, no Pixi.
 *
 * Layout (x 0..63):
 *   x 1..32   main desk floor (pod slots, 3 columns: desks only for people who are here,
 *             cozy nooks elsewhere; rows grow as people join)
 *   x 34..49  kitchen + lounge (top), meeting room (middle), game corner (bottom left) and
 *             The CFO's office (bottom right, x 45..49, door from the game corner at y 25..26)
 *   x 51..62  garden with the IT guy's server cabin; main door in the bottom wall at x 16..17
 *   x 63      hedge with a gate at y 7..8 (the garden path crosses into the street block)
 *   x 64..79  east street block: a sidewalk lane (x 64), the "Feierabend" bar (top), the
 *             weed shop (middle) and the smokers' corner (bottom); hedge at x 79
 *
 * To add an area: edit BASE_ROWS, add objects/areas/pois below. `test/map.test.ts`
 * checks row lengths and that every desk and POI is reachable from the door.
 */

export const TILE = 16;
/** Columns of the original office (desks, rooms, garden); the east street block comes after. */
export const OFFICE_COLS = 64;

/** Terrain legend. */
export const TERRAIN = {
  "#": "wallTop",
  U: "wallUpper",
  L: "wallLower",
  w: "window",
  f: "wallFace",
  ".": "wood",
  k: "kitchen",
  c: "carpet",
  m: "meeting",
  g: "game",
  ",": "grass",
  ":": "path",
  s: "sidewalk",
  o: "doorway",
  D: "door",
  "~": "water",
  h: "hedge",
  b: "bar",
  p: "shop",
} as const;
export type TerrainChar = keyof typeof TERRAIN;
export type Terrain = (typeof TERRAIN)[TerrainChar];

const WALKABLE: ReadonlySet<Terrain> = new Set([
  "wood",
  "kitchen",
  "carpet",
  "meeting",
  "game",
  "bar",
  "shop",
  "grass",
  "path",
  "sidewalk",
  "doorway",
  "door",
]);

const G_TOP = "hhhhhhhhhhhhh";
const G_GRASS = ",,,,,,,,,,,,h";
const G_CROSS = "::::::,,,,,,h";
const G_PATH = ",,,,::,,,,,,h";
const G_POND = ",,,,::,,~~~,h";
const G_GATE = ":".repeat(13);
const DESK_ROW = `#${".".repeat(32)}`;

// east street block (x 64..79): sidewalk lane, bar / shop walls, smokers' patio, hedge
const E_TOP = `h${"#".repeat(14)}h`;
const E_WALL = `s${"#".repeat(14)}h`;
const E_BAR_U = "s#UUUUwwUwwUUU#h";
const E_SHOP_U = "s#UUUUUUUUwwUU#h";
const E_LOW = `s#${"L".repeat(12)}#h`;
const E_BAR = `s#${"b".repeat(12)}#h`;
const E_BAR_DOOR = `so${"b".repeat(12)}#h`;
const E_SHOP = `s#${"p".repeat(12)}#h`;
const E_SHOP_DOOR = `so${"p".repeat(12)}#h`;
const E_LAWN = `s${",".repeat(14)}h`;
const E_PATIO = `s,${":".repeat(6)}${",".repeat(7)}h`;

/** Hand-written base map (80 x 30). Row comments give y. */
const BASE_ROWS: readonly string[] = [
  /*  0 */ `${"#".repeat(51)}${G_TOP}${E_TOP}`,
  /*  1 */ `#UUUUwwUUUUUwwUUUUUwwUUUUUwwUUUUU#UUUUUUUUUUUwwUUU#${G_GRASS}${E_BAR_U}`,
  /*  2 */ `#${"L".repeat(32)}#${"L".repeat(16)}#${G_GRASS}${E_LOW}`,
  /*  3 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_GRASS}${E_BAR}`,
  /*  4 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_GRASS}${E_BAR}`,
  /*  5 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_GRASS}${E_BAR}`,
  /*  6 */ `${DESK_ROW}okkkkkkkkcccccccc#${G_GRASS}${E_BAR}`,
  /*  7 */ `${DESK_ROW}okkkkkkkkcccccccco${G_GATE}${E_BAR_DOOR}`,
  /*  8 */ `${DESK_ROW}#kkkkkkkkcccccccco${G_GATE}${E_BAR_DOOR}`,
  /*  9 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_PATH}${E_BAR}`,
  /* 10 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_PATH}${E_BAR}`,
  /* 11 */ `${DESK_ROW}#####oo###########${G_PATH}${E_BAR}`,
  /* 12 */ `${DESK_ROW}#ffffooffffffffff#${G_POND}${E_WALL}`,
  /* 13 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_POND}${E_LAWN}`,
  /* 14 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_PATH}${E_WALL}`,
  /* 15 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_PATH}${E_SHOP_U}`,
  /* 16 */ `${DESK_ROW}ommmmmmmmmmmmmmmm#${G_PATH}${E_LOW}`,
  /* 17 */ `${DESK_ROW}ommmmmmmmmmmmmmmm#${G_PATH}${E_SHOP}`,
  /* 18 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_PATH}${E_SHOP}`,
  /* 19 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_PATH}${E_SHOP_DOOR}`,
  /* 20 */ `${DESK_ROW}#####oo###########${G_PATH}${E_SHOP_DOOR}`,
  /* 21 */ `${DESK_ROW}#ffffooffff#fffff#${G_PATH}${E_SHOP}`,
  /* 22 */ `${DESK_ROW}#gggggggggg#ccccc#${G_PATH}${E_SHOP}`,
  /* 23 */ `${DESK_ROW}#gggggggggg#ccccc#${G_PATH}${E_SHOP}`,
  /* 24 */ `${DESK_ROW}ogggggggggg#ccccc#${G_CROSS}${E_WALL}`,
  /* 25 */ `${DESK_ROW}oggggggggggoccccc#${G_CROSS}${E_PATIO}`,
  /* 26 */ `${DESK_ROW}#ggggggggggoccccc#${G_PATH}${E_PATIO}`,
  /* 27 */ `${DESK_ROW}#gggggggggg#ccccc#${G_PATH}${E_LAWN}`,
  /* 28 */ `${"#".repeat(16)}DD${"#".repeat(33)}${G_PATH}${E_LAWN}`,
  /* 29 */ `${"s".repeat(79)}h`,
];

/** Template row repeated (6 per pod row) when the desk floor grows. */
const GROW_ROW = `${DESK_ROW}#gggggggggg#ccccc#${G_PATH}${E_LAWN}`;
/** Rows are inserted before this y (the last floor row, so things along the bottom wall move with it). */
const GROW_AT = 27;
export const BASE_POD_ROWS = 4;

// ---- pods -----------------------------------------------------------------------------------
/**
 * The desk floor is a grid of pod *slots* (3 per row). A slot only gets desks once a person
 * owns it; empty slots are cozy nooks (see `NOOKS`), the next free one shows a 2-desk
 * "free desk" placeholder. A pod has 2..6 desks (one per session, the pod grows with them):
 * up to 4 at a 32 px pitch, 5 at 26 px and 6 at 24 px so every pod fits its 10-tile slot.
 */
export const POD_COLS = 3;
export const MIN_DESKS = 2;
export const MAX_DESKS = 6;
/** @deprecated kept for older imports: desks of a "classic" 4-desk pod */
export const DESKS_PER_POD = 4;
const POD_X0 = 3;
const POD_Y0 = 4;
const POD_W = 10;
const POD_H = 6;

export type Point = { x: number; y: number };

/** Top-left tile of a slot's (classic, 4-desk) first desk. Slots fill row-major, 3 per row. */
export function podOrigin(pod: number): Point {
  return { x: POD_X0 + (pod % POD_COLS) * POD_W, y: POD_Y0 + Math.floor(pod / POD_COLS) * POD_H };
}
/** Pixel x of the slot's center line. */
export function podCenterX(pod: number): number {
  return (podOrigin(pod).x + 4) * TILE;
}
export function deskPitch(n: number): number {
  return n <= 4 ? 32 : n === 5 ? 26 : 24;
}
export function clampDesks(n: number): number {
  return Math.max(MIN_DESKS, Math.min(MAX_DESKS, n));
}
/** Pixel rect of a pod's desk row (n desks). */
export function podDeskSpan(pod: number, n: number): { x: number; w: number } {
  const w = n * deskPitch(n);
  // big pods start one tile left of the slot so the 1-tile gap to the next slot stays open
  if (n > 4) return { x: (podOrigin(pod).x - 1) * TILE + Math.floor((9 * TILE - w) / 2), w };
  return { x: Math.round(podCenterX(pod) - w / 2), w };
}
/** Pixel position of a desk's top-left (desk top surface starts at y + 3). */
export function deskPx(pod: number, desk: number, n: number): Point {
  const span = podDeskSpan(pod, n);
  return { x: span.x + desk * deskPitch(n), y: podOrigin(pod).y * TILE };
}
/** Pixel position of a seated character's feet (centered on the desk). */
export function seatPoint(pod: number, desk: number, n: number = DESKS_PER_POD): Point {
  const d = deskPx(pod, desk, n);
  return { x: d.x + Math.round(deskPitch(n) / 2), y: d.y + 34 };
}
/** Walkable tile right in front of the desk where the chair stands. */
export function chairTile(pod: number, desk: number, n: number = DESKS_PER_POD): Point {
  const s = seatPoint(pod, desk, n);
  return { x: Math.floor(s.x / TILE), y: podOrigin(pod).y + 2 };
}
/** Tiles covered by a pod's desks (blocked for walking). */
export function podDeskTiles(pod: number, n: number): { x0: number; x1: number; y: number } {
  const span = podDeskSpan(pod, n);
  return {
    x0: Math.floor(span.x / TILE),
    x1: Math.floor((span.x + span.w - 1) / TILE),
    y: podOrigin(pod).y,
  };
}
/** Pixel rect of the floor strip in front of a pod (nameplate + aisle), for helper bots. */
export function podAisle(pod: number): { x: number; y: number; w: number; h: number } {
  const o = podOrigin(pod);
  return { x: o.x * TILE, y: (o.y + 4) * TILE + 4, w: 8 * TILE, h: TILE + 6 };
}
export function podRowsFor(podCount: number): number {
  return Math.max(BASE_POD_ROWS, Math.ceil(podCount / POD_COLS));
}

/** Block (or free) the tiles of a slot: desks of an n-desk pod, or a nook's furniture. */
export function setSlotBlocked(map: OfficeMap, pod: number, tiles: readonly Point[]) {
  const o = podOrigin(pod);
  // reset the slot's furniture band (rows y..y+3, the 10 slot columns minus the aisles)
  for (let y = o.y; y < o.y + 4; y++) {
    for (let x = o.x - 1; x <= o.x + 8; x++) map.setWalkable(x, y, map.baseWalkable(x, y));
  }
  for (const t of tiles) map.setWalkable(t.x, t.y, false);
}
export function podBlockTiles(pod: number, n: number): Point[] {
  const t = podDeskTiles(pod, n);
  const out: Point[] = [];
  for (let x = t.x0; x <= t.x1; x++) out.push({ x, y: t.y }, { x, y: t.y + 1 });
  return out;
}

// ---- objects --------------------------------------------------------------------------------
export const FOOTPRINTS = {
  fridge: { w: 1, h: 1, solid: true },
  counter: { w: 1, h: 1, solid: true },
  coffee: { w: 1, h: 1, solid: false },
  sink: { w: 1, h: 1, solid: false },
  cooler: { w: 1, h: 1, solid: true },
  bistro: { w: 1, h: 1, solid: true },
  stool: { w: 1, h: 1, solid: false },
  bookshelf: { w: 2, h: 1, solid: true },
  plantBig: { w: 1, h: 1, solid: true },
  plant: { w: 1, h: 1, solid: true },
  sofa: { w: 3, h: 1, solid: true },
  rug: { w: 5, h: 3, solid: false },
  coffeeTable: { w: 1, h: 1, solid: true },
  armchair: { w: 1, h: 1, solid: true },
  floorLamp: { w: 1, h: 1, solid: true },
  whiteboard: { w: 3, h: 1, solid: false },
  meetingTable: { w: 6, h: 2, solid: true },
  meetingChair: { w: 1, h: 1, solid: false },
  arcade: { w: 1, h: 1, solid: true },
  neon: { w: 3, h: 1, solid: false },
  pingpong: { w: 3, h: 2, solid: true },
  beanbag: { w: 1, h: 1, solid: false },
  tv: { w: 2, h: 1, solid: true },
  tree: { w: 2, h: 1, solid: true },
  bench: { w: 2, h: 1, solid: true },
  flowers: { w: 2, h: 1, solid: true },
  lampPost: { w: 1, h: 1, solid: true },
  parasol: { w: 2, h: 1, solid: true },
  printer: { w: 1, h: 1, solid: true },
  serverRack: { w: 1, h: 1, solid: true },
  bush: { w: 1, h: 1, solid: true },
  doormat: { w: 2, h: 1, solid: false },
  // bar
  barCounter: { w: 6, h: 1, solid: true },
  barBack: { w: 1, h: 1, solid: true },
  beerTap: { w: 1, h: 1, solid: false },
  barStool: { w: 1, h: 1, solid: false },
  bottleShelf: { w: 3, h: 1, solid: true },
  standingTable: { w: 1, h: 1, solid: true },
  neonBeer: { w: 3, h: 1, solid: false },
  // weed shop + smokers' corner
  shopCounter: { w: 3, h: 1, solid: true },
  jarShelf: { w: 3, h: 1, solid: true },
  greenCross: { w: 1, h: 1, solid: false },
  openSign: { w: 2, h: 1, solid: false },
  ashtray: { w: 1, h: 1, solid: true },
  stove: { w: 1, h: 1, solid: true },
  headDesk: { w: 3, h: 1, solid: true },
  timeClock: { w: 1, h: 1, solid: false },
  salesStand: { w: 2, h: 1, solid: true },
  cfoDesk: { w: 2, h: 1, solid: true },
  fileCabinet: { w: 1, h: 1, solid: true },
  serverCabin: { w: 4, h: 2, solid: true },
} as const;
export type ObjectKind = keyof typeof FOOTPRINTS;
export type MapObject = { kind: ObjectKind; x: number; y: number; variant?: number };

/** Left tile of the head of development's desk (3 wide, she sits behind it facing the room). */
export const HEAD_DESK: Point = { x: 46, y: 14 };
/** Left tile of the sales stand in the garden (2 wide, the seller stands behind it). */
export const SALES_STAND: Point = { x: 52, y: 22 };
/** Where the cook stands at the stove. */
export const STOVE_SPOT: Point = { x: 35, y: 4 };
/** Left tile of the CFO's desk (2 wide, he sits behind it facing the door of his office). */
export const CFO_DESK: Point = { x: 46, y: 23 };
/** Left tile of the IT guy's wooden server cabin in the garden (4 wide, 2 deep). */
export const SERVER_CABIN: Point = { x: 56, y: 4 };
/** The tile in front of the cabin door (the IT guy goes in and out here). */
export const CABIN_DOOR: Point = { x: 58, y: 6 };
/** Where the IT guy stands to spray the burning cabin roof. */
export const CABIN_HOSE: Point = { x: 57, y: 6 };
/** Where the IT guy stands (facing up) to put RAM into the server rack on the desk floor. */
export const RACK_SPOT: Point = { x: 32, y: 16 };

const o = (kind: ObjectKind, x: number, y: number, variant?: number): MapObject =>
  variant === undefined ? { kind, x, y } : { kind, x, y, variant };

const BASE_OBJECTS: readonly MapObject[] = [
  // kitchen
  o("fridge", 34, 3),
  o("stove", 35, 3),
  ...[36, 37, 38, 39, 40].map((x) => o("counter", x, 3)),
  o("coffee", 37, 3),
  o("sink", 39, 3),
  o("cooler", 41, 3),
  o("bistro", 37, 7),
  o("stool", 36, 7),
  o("stool", 38, 7, 1),
  o("plant", 34, 10, 1),
  // lounge
  o("bookshelf", 42, 3),
  o("plantBig", 49, 3),
  o("sofa", 44, 4),
  o("rug", 43, 6),
  o("coffeeTable", 45, 7),
  o("armchair", 48, 7),
  o("floorLamp", 42, 5),
  o("beanbag", 47, 10),
  o("plant", 42, 10, 2),
  // meeting room
  o("whiteboard", 41, 12),
  o("meetingTable", 39, 15),
  ...[40, 42, 44].map((x) => o("meetingChair", x, 14)),
  ...[40, 43].map((x) => o("meetingChair", x, 17, 1)),
  o("plant", 34, 13),
  o("plant", 49, 13, 1),
  o("plantBig", 49, 19),
  o("floorLamp", 34, 19),
  o("headDesk", HEAD_DESK.x, HEAD_DESK.y),
  o("timeClock", 45, 12),
  // game corner
  o("arcade", 35, 22, 0),
  o("arcade", 36, 22, 1),
  o("arcade", 37, 22, 2),
  o("neon", 40, 21),
  o("tv", 42, 22),
  o("beanbag", 42, 23, 1),
  o("beanbag", 43, 23, 2),
  o("pingpong", 40, 25),
  // The CFO's office (x 45..49, door at x 44, y 25..26)
  o("cfoDesk", CFO_DESK.x, CFO_DESK.y),
  o("fileCabinet", 45, 22),
  o("plant", 49, 22, 2),
  o("plantBig", 49, 27),
  o("floorLamp", 34, 27),
  // garden
  o("tree", 52, 3),
  o("tree", 61, 3, 1),
  o("tree", 60, 17),
  o("tree", 52, 19, 1),
  o("tree", 59, 27),
  o("bench", 58, 9),
  o("bench", 52, 14, 1),
  o("flowers", 52, 10),
  o("flowers", 58, 23, 1),
  o("flowers", 60, 6, 2),
  o("lampPost", 54, 6),
  o("lampPost", 57, 21),
  o("salesStand", SALES_STAND.x, SALES_STAND.y),
  o("serverCabin", SERVER_CABIN.x, SERVER_CABIN.y),
  o("parasol", 58, 19),
  o("bush", 62, 11),
  o("bush", 51, 26, 1),
  o("bush", 62, 24, 2),
  // desk floor
  o("plantBig", 1, 3),
  o("plantBig", 32, 3),
  o("plant", 1, 27),
  o("plant", 32, 27, 1),
  o("cooler", 1, 15),
  o("printer", 32, 9),
  o("serverRack", 32, 15),
  o("floorLamp", 1, 9),
  o("floorLamp", 32, 21),
  o("doormat", 16, 27),
  // "Feierabend" bar (x 66..77, y 3..11; door at x 65, y 7..8)
  o("bottleShelf", 66, 3),
  ...[69, 70, 71].map((x) => o("barBack", x, 3)),
  o("beerTap", 70, 3),
  o("barCounter", 66, 5),
  ...[67, 68, 70, 71].map((x, i) => o("barStool", x, 6, i % 2)),
  o("neonBeer", 75, 2),
  o("standingTable", 75, 5),
  o("standingTable", 75, 9),
  o("plantBig", 77, 7),
  o("plant", 77, 11, 1),
  o("floorLamp", 66, 11),
  // weed shop (x 66..77, y 17..23; door at x 65, y 19..20)
  o("jarShelf", 66, 17),
  o("jarShelf", 69, 17, 1),
  o("openSign", 72, 16),
  o("greenCross", 76, 16),
  o("shopCounter", 72, 20),
  o("plantBig", 77, 17),
  o("armchair", 76, 22),
  o("plant", 66, 23, 2),
  // smokers' corner (patio x 66..71, y 25..26)
  o("ashtray", 68, 25),
  o("bench", 73, 25, 1),
  o("lampPost", 77, 26),
  o("bush", 78, 25, 1),
];

// ---- areas & points of interest -------------------------------------------------------------
export type AreaName =
  | "desks"
  | "kitchen"
  | "lounge"
  | "meeting"
  | "game"
  | "cfo"
  | "garden"
  | "bar"
  | "shop";
export type Area = { name: AreaName; label: string; x: number; y: number; w: number; h: number };
export type Facing = "down" | "up" | "left" | "right";
/** stand = standing; sit = seated facing camera; sitBack = seated facing away; play = busy standing */
export type PoiPose = "stand" | "sit" | "sitBack" | "play";
export type Poi = {
  id: string;
  area: AreaName;
  /** walkable tile to path to */
  tile: Point;
  /** optional final pixel position (feet), e.g. on a sofa */
  spot?: Point;
  face: Facing;
  pose: PoiPose;
};

const seat = (tx: number, ty: number): Point => ({ x: tx * TILE + 8, y: ty * TILE + 13 });
const poi = (
  id: string,
  area: AreaName,
  tx: number,
  ty: number,
  face: Facing,
  pose: PoiPose,
  spot?: Point,
): Poi =>
  spot
    ? { id, area, tile: { x: tx, y: ty }, face, pose, spot }
    : { id, area, tile: { x: tx, y: ty }, face, pose };

const BASE_POIS: readonly Poi[] = [
  poi("coffee", "kitchen", 37, 4, "up", "play"),
  poi("sink", "kitchen", 39, 4, "up", "stand"),
  poi("cooler-k", "kitchen", 41, 4, "up", "stand"),
  poi("bistro-l", "kitchen", 36, 7, "right", "stand"),
  poi("bistro-r", "kitchen", 38, 7, "left", "stand"),
  poi("fridge", "kitchen", 34, 4, "up", "stand"),
  // the snack pass is only open while the cook is at the stove
  poi("snack", "kitchen", 36, 4, "up", "stand"),
  poi("timeclock", "meeting", 45, 13, "up", "play"),
  poi("sofa-1", "lounge", 44, 5, "down", "sit", seat(44, 4)),
  poi("sofa-2", "lounge", 45, 5, "down", "sit", seat(45, 4)),
  poi("sofa-3", "lounge", 46, 5, "down", "sit", seat(46, 4)),
  poi("armchair", "lounge", 48, 8, "down", "sit", seat(48, 7)),
  poi("books", "lounge", 43, 4, "up", "stand"),
  poi("beanbag-l", "lounge", 47, 10, "up", "sitBack", seat(47, 10)),
  poi("whiteboard", "meeting", 42, 13, "up", "play"),
  poi("meet-1", "meeting", 40, 14, "down", "sit", seat(40, 14)),
  poi("meet-2", "meeting", 42, 14, "down", "sit", seat(42, 14)),
  poi("meet-3", "meeting", 44, 14, "down", "sit", seat(44, 14)),
  poi("meet-4", "meeting", 40, 17, "up", "sitBack", seat(40, 17)),
  poi("meet-5", "meeting", 43, 17, "up", "sitBack", seat(43, 17)),
  poi("arcade-1", "game", 35, 23, "up", "play"),
  poi("arcade-2", "game", 36, 23, "up", "play"),
  poi("arcade-3", "game", 37, 23, "up", "play"),
  poi("pong-l", "game", 39, 25, "right", "play"),
  poi("pong-r", "game", 43, 25, "left", "play"),
  poi("tv-1", "game", 42, 23, "up", "sitBack", seat(42, 23)),
  poi("tv-2", "game", 43, 23, "up", "sitBack", seat(43, 23)),
  // in front of the CFO's desk: ask him for a contract
  poi("cfo", "cfo", CFO_DESK.x, CFO_DESK.y + 1, "up", "stand"),
  poi("bench-1", "garden", 58, 10, "down", "sit", seat(58, 9)),
  poi("bench-2", "garden", 59, 10, "down", "sit", seat(59, 9)),
  poi("bench-3", "garden", 52, 15, "down", "sit", seat(52, 14)),
  poi("bench-4", "garden", 53, 15, "down", "sit", seat(53, 14)),
  poi("pond", "garden", 58, 13, "right", "stand"),
  poi("flowers", "garden", 53, 11, "up", "stand"),
  poi("parasol", "garden", 58, 20, "up", "stand"),
  poi("cooler-d", "desks", 2, 15, "left", "stand"),
  poi("printer", "desks", 31, 9, "right", "stand"),
  poi("plant-d", "desks", 2, 3, "left", "stand"),
  // bar: pour a beer at the tap, sit at the counter, lean on a standing table
  poi("tap", "bar", 70, 4, "up", "play"),
  poi("bar-1", "bar", 67, 6, "up", "sitBack", seat(67, 6)),
  poi("bar-2", "bar", 68, 6, "up", "sitBack", seat(68, 6)),
  poi("bar-3", "bar", 70, 6, "up", "sitBack", seat(70, 6)),
  poi("bar-4", "bar", 71, 6, "up", "sitBack", seat(71, 6)),
  poi("table-1l", "bar", 74, 5, "right", "stand"),
  poi("table-1r", "bar", 76, 5, "left", "stand"),
  poi("table-2l", "bar", 74, 9, "right", "stand"),
  poi("table-2r", "bar", 76, 9, "left", "stand"),
  // weed shop: buy at the counter, browse the jars, sit in the armchair
  poi("shop-counter", "shop", 73, 21, "up", "stand"),
  poi("jars-1", "shop", 67, 18, "up", "stand"),
  poi("jars-2", "shop", 70, 18, "up", "stand"),
  poi("shop-chair", "shop", 76, 23, "down", "sit", seat(76, 22)),
  // smokers' corner (outside, open around the clock)
  poi("smoke-1", "shop", 67, 25, "right", "stand"),
  poi("smoke-2", "shop", 69, 25, "left", "stand"),
  poi("smoke-3", "shop", 73, 26, "down", "sit", seat(73, 25)),
  poi("smoke-4", "shop", 74, 26, "down", "sit", seat(74, 25)),
];

/** Bar spots (only while the bar is open). */
export const isBarPoi = (p: Poi) => p.area === "bar";
/** The 4 stools at the bar counter (seated facing away from the camera). */
export const isBarStool = (p: Poi) => p.id.startsWith("bar-");
/** Smokers' corner spots (outside the shop, always open). */
export const isSmokePoi = (p: Poi) => p.id.startsWith("smoke-");
/** Inside the shop (only while it is open). */
export const isShopPoi = (p: Poi) => p.area === "shop" && !isSmokePoi(p);

// ---- nooks (empty pod slots) ------------------------------------------------------------------
type NookSpec = {
  name: string;
  /** rug in tiles relative to the slot origin */
  rug: { dx: number; dy: number; w: number; h: number; variant: number };
  objects: readonly { kind: ObjectKind; dx: number; dy: number; variant?: number }[];
  pois: readonly { dx: number; dy: number; face: Facing; pose: PoiPose; sx: number; sy: number }[];
};
/** Cozy corners for unoccupied slots (8x4 tiles; the slot's aisles stay free). */
const NOOKS: readonly NookSpec[] = [
  {
    name: "reading",
    rug: { dx: 2, dy: 1, w: 5, h: 3, variant: 0 },
    objects: [
      { kind: "bookshelf", dx: 0, dy: 0 },
      { kind: "armchair", dx: 3, dy: 1 },
      { kind: "armchair", dx: 5, dy: 1 },
      { kind: "coffeeTable", dx: 4, dy: 2 },
      { kind: "plant", dx: 7, dy: 1, variant: 2 },
    ],
    pois: [
      { dx: 3, dy: 2, face: "down", pose: "sit", sx: 3, sy: 1 },
      { dx: 5, dy: 2, face: "down", pose: "sit", sx: 5, sy: 1 },
    ],
  },
  {
    name: "greenery",
    rug: { dx: 2, dy: 2, w: 3, h: 2, variant: 3 },
    objects: [
      { kind: "plantBig", dx: 1, dy: 1 },
      { kind: "plant", dx: 2, dy: 1, variant: 2 },
      { kind: "beanbag", dx: 3, dy: 2, variant: 1 },
      { kind: "plant", dx: 6, dy: 2, variant: 1 },
      { kind: "plantBig", dx: 7, dy: 1 },
    ],
    pois: [{ dx: 3, dy: 2, face: "down", pose: "sitBack", sx: 3, sy: 2 }],
  },
  {
    name: "movie",
    rug: { dx: 2, dy: 1, w: 4, h: 3, variant: 1 },
    objects: [
      { kind: "tv", dx: 3, dy: 0 },
      { kind: "beanbag", dx: 3, dy: 2, variant: 0 },
      { kind: "beanbag", dx: 4, dy: 2, variant: 2 },
      { kind: "plant", dx: 6, dy: 0, variant: 1 },
    ],
    pois: [
      { dx: 3, dy: 2, face: "up", pose: "sitBack", sx: 3, sy: 2 },
      { dx: 4, dy: 2, face: "up", pose: "sitBack", sx: 4, sy: 2 },
    ],
  },
  {
    name: "open",
    rug: { dx: 3, dy: 1, w: 3, h: 2, variant: 2 },
    objects: [
      { kind: "floorLamp", dx: 2, dy: 1 },
      { kind: "plant", dx: 6, dy: 1, variant: 0 },
    ],
    pois: [{ dx: 4, dy: 2, face: "down", pose: "stand", sx: 4, sy: 2 }],
  },
  {
    name: "sofa",
    rug: { dx: 1, dy: 1, w: 5, h: 3, variant: 2 },
    objects: [
      { kind: "plant", dx: 0, dy: 1, variant: 0 },
      { kind: "sofa", dx: 2, dy: 1 },
      { kind: "floorLamp", dx: 5, dy: 1 },
      { kind: "coffeeTable", dx: 3, dy: 3 },
    ],
    pois: [
      { dx: 2, dy: 2, face: "down", pose: "sit", sx: 2, sy: 1 },
      { dx: 4, dy: 2, face: "down", pose: "sit", sx: 4, sy: 1 },
    ],
  },
  {
    name: "beanbags",
    rug: { dx: 2, dy: 1, w: 4, h: 3, variant: 3 },
    objects: [
      { kind: "beanbag", dx: 2, dy: 2, variant: 2 },
      { kind: "beanbag", dx: 4, dy: 2, variant: 0 },
      { kind: "coffeeTable", dx: 3, dy: 2 },
      { kind: "plantBig", dx: 7, dy: 0 },
    ],
    pois: [
      { dx: 2, dy: 2, face: "right", pose: "sitBack", sx: 2, sy: 2 },
      { dx: 4, dy: 2, face: "left", pose: "sitBack", sx: 4, sy: 2 },
    ],
  },
];
/** Nook per slot: row and column neighbours always differ. */
const NOOK_ORDER = [0, 2, 4, 3, 1, 5, 4, 5, 0, 2, 3, 1];

export type NookLayout = {
  name: string;
  rug: { x: number; y: number; w: number; h: number; variant: number };
  objects: MapObject[];
  pois: Poi[];
  block: Point[];
};

/** Which nook an empty slot shows (neighbours differ). */
export function nookVariant(pod: number): number {
  return (
    (NOOK_ORDER[pod % NOOK_ORDER.length]! + Math.floor(pod / NOOK_ORDER.length)) % NOOKS.length
  );
}

export function nookLayout(pod: number): NookLayout {
  const spec = NOOKS[nookVariant(pod)]!;
  const o = podOrigin(pod);
  const objects = spec.objects.map((ob) => ({
    kind: ob.kind,
    x: o.x + ob.dx,
    y: o.y + ob.dy,
    ...(ob.variant !== undefined ? { variant: ob.variant } : {}),
  }));
  const block: Point[] = [];
  for (const ob of objects) {
    const fp = FOOTPRINTS[ob.kind];
    if (!fp.solid) continue;
    for (let j = 0; j < fp.h; j++)
      for (let i = 0; i < fp.w; i++) block.push({ x: ob.x + i, y: ob.y + j });
  }
  const pois = spec.pois.map((p, i) =>
    poi(
      `nook-${pod}-${i}`,
      "desks",
      o.x + p.dx,
      o.y + p.dy,
      p.face,
      p.pose,
      seat(o.x + p.sx, o.y + p.sy),
    ),
  );
  const r = spec.rug;
  return {
    name: spec.name,
    rug: {
      x: (o.x + r.dx) * TILE + 4,
      y: (o.y + r.dy) * TILE + 4,
      w: r.w * TILE - 8,
      h: r.h * TILE - 8,
      variant: r.variant,
    },
    objects,
    pois,
    block,
  };
}

export type OfficeMap = {
  width: number;
  height: number;
  podRows: number;
  rows: readonly string[];
  objects: readonly MapObject[];
  areas: readonly Area[];
  pois: readonly Poi[];
  /** left tile of the 2-wide main door */
  door: Point;
  /** tile outside the door where walk-ins start */
  spawn: Point;
  walkable: Uint8Array;
  terrainAt(x: number, y: number): Terrain | undefined;
  isWalkable(x: number, y: number): boolean;
  /** walkability from terrain + static objects only (no pods / nooks) */
  baseWalkable(x: number, y: number): boolean;
  setWalkable(x: number, y: number, on: boolean): void;
};

export function buildOfficeMap(podRows: number = BASE_POD_ROWS): OfficeMap {
  const extra = Math.max(0, podRows - BASE_POD_ROWS) * POD_H;
  const rows = [...BASE_ROWS];
  rows.splice(GROW_AT, 0, ...Array.from({ length: extra }, () => GROW_ROW));
  const width = rows[0]!.length;
  const height = rows.length;
  for (const [i, r] of rows.entries()) {
    if (r.length !== width) throw new Error(`map row ${i} has length ${r.length}, want ${width}`);
  }
  const shift = (y: number) => (y >= GROW_AT ? y + extra : y);
  const objects = BASE_OBJECTS.map((ob) => ({ ...ob, y: shift(ob.y) }));
  const pois = BASE_POIS.map((p) => ({
    ...p,
    tile: { x: p.tile.x, y: shift(p.tile.y) },
    ...(p.spot
      ? { spot: { x: p.spot.x, y: p.spot.y + (p.spot.y >= GROW_AT * TILE ? extra * TILE : 0) } }
      : {}),
  }));
  const deskBottom = POD_Y0 + podRows * POD_H; // exclusive
  const areas: Area[] = [
    { name: "desks", label: "Desk floor", x: 1, y: 3, w: 32, h: deskBottom - 2 },
    { name: "kitchen", label: "Kitchen", x: 34, y: 3, w: 8, h: 8 },
    { name: "lounge", label: "Lounge", x: 42, y: 3, w: 8, h: 8 },
    { name: "meeting", label: "Meeting room", x: 34, y: 13, w: 16, h: 7 },
    { name: "game", label: "Game corner", x: 34, y: 22, w: 10, h: 6 + extra },
    { name: "cfo", label: "CFO's office", x: 45, y: 22, w: 5, h: 6 + extra },
    { name: "garden", label: "Garden", x: 51, y: 1, w: 12, h: height - 2 },
    { name: "bar", label: "Bar", x: 65, y: 1, w: 14, h: 12 },
    { name: "shop", label: "Weed shop", x: 65, y: 15, w: 14, h: 13 + extra },
  ];

  const terrainAt = (x: number, y: number): Terrain | undefined => {
    const ch = rows[y]?.[x] as TerrainChar | undefined;
    return ch ? TERRAIN[ch] : undefined;
  };
  const walkable = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = terrainAt(x, y);
      walkable[y * width + x] = t && WALKABLE.has(t) ? 1 : 0;
    }
  }
  const block = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) walkable[y * width + x] = 0;
  };
  for (const ob of objects) {
    const fp = FOOTPRINTS[ob.kind];
    if (!fp.solid) continue;
    for (let j = 0; j < fp.h; j++) for (let i = 0; i < fp.w; i++) block(ob.x + i, ob.y + j);
  }
  const base = walkable.slice();
  const isWalkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && walkable[y * width + x] === 1;

  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  return {
    width,
    height,
    podRows,
    rows,
    objects,
    areas,
    pois,
    door: { x: 16, y: shift(28) },
    spawn: { x: 16, y: shift(29) },
    walkable,
    terrainAt,
    isWalkable,
    baseWalkable: (x, y) => inside(x, y) && base[y * width + x] === 1,
    setWalkable(x, y, on) {
      if (inside(x, y)) walkable[y * width + x] = on ? 1 : 0;
    },
  };
}

export function areaCenter(a: Area): Point {
  return { x: (a.x + a.w / 2) * TILE, y: (a.y + a.h / 2) * TILE };
}
