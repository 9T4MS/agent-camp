/**
 * The office map: a hand-written tile grid (one char per 16 px tile) plus a list of
 * furniture objects, named areas and points of interest. Pure data + helpers, no Pixi.
 *
 * Layout (x 0..63):
 *   x 1..32   main desk floor (pods of 4 desks, 3 columns, rows grow as people join)
 *   x 34..49  kitchen + lounge (top), meeting room (middle), game corner (bottom)
 *   x 51..62  garden; main door in the bottom wall at x 16..17
 *
 * To add an area: edit BASE_ROWS, add objects/areas/pois below. `test/map.test.ts`
 * checks row lengths and that every desk and POI is reachable from the door.
 */

export const TILE = 16;

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
} as const;
export type TerrainChar = keyof typeof TERRAIN;
export type Terrain = (typeof TERRAIN)[TerrainChar];

const WALKABLE: ReadonlySet<Terrain> = new Set([
  "wood",
  "kitchen",
  "carpet",
  "meeting",
  "game",
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
const DESK_ROW = `#${".".repeat(32)}`;

/** Hand-written base map (64 x 30). Row comments give y. */
const BASE_ROWS: readonly string[] = [
  /*  0 */ `${"#".repeat(51)}${G_TOP}`,
  /*  1 */ `#UUUUwwUUUUUwwUUUUUwwUUUUUwwUUUUU#UUUUUUUUUUUwwUUU#${G_GRASS}`,
  /*  2 */ `#${"L".repeat(32)}#${"L".repeat(16)}#${G_GRASS}`,
  /*  3 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_GRASS}`,
  /*  4 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_GRASS}`,
  /*  5 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_GRASS}`,
  /*  6 */ `${DESK_ROW}okkkkkkkkcccccccc#${G_GRASS}`,
  /*  7 */ `${DESK_ROW}okkkkkkkkcccccccco${G_CROSS}`,
  /*  8 */ `${DESK_ROW}#kkkkkkkkcccccccco${G_CROSS}`,
  /*  9 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_PATH}`,
  /* 10 */ `${DESK_ROW}#kkkkkkkkcccccccc#${G_PATH}`,
  /* 11 */ `${DESK_ROW}#####oo###########${G_PATH}`,
  /* 12 */ `${DESK_ROW}#ffffooffffffffff#${G_POND}`,
  /* 13 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_POND}`,
  /* 14 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_PATH}`,
  /* 15 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_PATH}`,
  /* 16 */ `${DESK_ROW}ommmmmmmmmmmmmmmm#${G_PATH}`,
  /* 17 */ `${DESK_ROW}ommmmmmmmmmmmmmmm#${G_PATH}`,
  /* 18 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_PATH}`,
  /* 19 */ `${DESK_ROW}#mmmmmmmmmmmmmmmm#${G_PATH}`,
  /* 20 */ `${DESK_ROW}#####oo###########${G_PATH}`,
  /* 21 */ `${DESK_ROW}#ffffooffffffffff#${G_PATH}`,
  /* 22 */ `${DESK_ROW}#gggggggggggggggg#${G_PATH}`,
  /* 23 */ `${DESK_ROW}#gggggggggggggggg#${G_PATH}`,
  /* 24 */ `${DESK_ROW}oggggggggggggggggo${G_CROSS}`,
  /* 25 */ `${DESK_ROW}oggggggggggggggggo${G_CROSS}`,
  /* 26 */ `${DESK_ROW}#gggggggggggggggg#${G_PATH}`,
  /* 27 */ `${DESK_ROW}#gggggggggggggggg#${G_PATH}`,
  /* 28 */ `${"#".repeat(16)}DD${"#".repeat(33)}${G_PATH}`,
  /* 29 */ `${"s".repeat(51)}ssssssssssssh`,
];

/** Template row repeated (6 per pod row) when the desk floor grows. */
const GROW_ROW = `${DESK_ROW}#gggggggggggggggg#${G_PATH}`;
/** Rows are inserted before this y (the bottom wall). */
const GROW_AT = 28;
export const BASE_POD_ROWS = 4;

// ---- pods -----------------------------------------------------------------------------------
export const POD_COLS = 3;
export const DESKS_PER_POD = 4;
const POD_X0 = 3;
const POD_Y0 = 4;
const POD_W = 10;
const POD_H = 6;

export type Point = { x: number; y: number };

/** Top-left tile of a pod's first desk. Pods fill row-major, 3 per row. */
export function podOrigin(pod: number): Point {
  return { x: POD_X0 + (pod % POD_COLS) * POD_W, y: POD_Y0 + Math.floor(pod / POD_COLS) * POD_H };
}
/** Top-left tile of a desk (each desk is 2x2 tiles: monitor/top + front). */
export function deskTile(pod: number, desk: number): Point {
  const o = podOrigin(pod);
  return { x: o.x + desk * 2, y: o.y };
}
/** Walkable tile right in front of the desk where the chair stands. */
export function chairTile(pod: number, desk: number): Point {
  const d = deskTile(pod, desk);
  return { x: d.x, y: d.y + 2 };
}
/** Pixel position of a seated character's feet (between the desk's two tiles). */
export function seatPoint(pod: number, desk: number): Point {
  const d = deskTile(pod, desk);
  return { x: (d.x + 1) * TILE, y: d.y * TILE + 34 };
}
/** Pixel rect of the floor strip in front of a pod (nameplate + aisle), for helper bots. */
export function podAisle(pod: number): { x: number; y: number; w: number; h: number } {
  const o = podOrigin(pod);
  return { x: o.x * TILE, y: (o.y + 4) * TILE + 4, w: DESKS_PER_POD * 2 * TILE, h: TILE + 6 };
}
export function podRowsFor(podCount: number): number {
  return Math.max(BASE_POD_ROWS, Math.ceil(podCount / POD_COLS));
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
  bush: { w: 1, h: 1, solid: true },
  doormat: { w: 2, h: 1, solid: false },
} as const;
export type ObjectKind = keyof typeof FOOTPRINTS;
export type MapObject = { kind: ObjectKind; x: number; y: number; variant?: number };

const o = (kind: ObjectKind, x: number, y: number, variant?: number): MapObject =>
  variant === undefined ? { kind, x, y } : { kind, x, y, variant };

const BASE_OBJECTS: readonly MapObject[] = [
  // kitchen
  o("fridge", 34, 3),
  ...[35, 36, 37, 38, 39, 40].map((x) => o("counter", x, 3)),
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
  // game corner
  o("arcade", 35, 22, 0),
  o("arcade", 36, 22, 1),
  o("arcade", 37, 22, 2),
  o("neon", 40, 21),
  o("tv", 46, 22),
  o("beanbag", 46, 24, 1),
  o("beanbag", 47, 24, 2),
  o("pingpong", 40, 25),
  o("plant", 49, 22, 2),
  o("plantBig", 49, 27),
  o("floorLamp", 34, 27),
  // garden
  o("tree", 52, 3),
  o("tree", 59, 2, 1),
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
  o("floorLamp", 1, 9),
  o("floorLamp", 32, 21),
  o("doormat", 16, 27),
];

// ---- areas & points of interest -------------------------------------------------------------
export type AreaName = "desks" | "kitchen" | "lounge" | "meeting" | "game" | "garden";
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
  poi("tv-1", "game", 46, 24, "up", "sitBack", seat(46, 24)),
  poi("tv-2", "game", 47, 24, "up", "sitBack", seat(47, 24)),
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
];

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
    { name: "game", label: "Game corner", x: 34, y: 22, w: 16, h: 6 + extra },
    { name: "garden", label: "Garden", x: 51, y: 1, w: 12, h: height - 2 },
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
  for (let pod = 0; pod < podRows * POD_COLS; pod++) {
    for (let d = 0; d < DESKS_PER_POD; d++) {
      const t = deskTile(pod, d);
      block(t.x, t.y);
      block(t.x + 1, t.y);
      block(t.x, t.y + 1);
      block(t.x + 1, t.y + 1);
    }
  }
  const isWalkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && walkable[y * width + x] === 1;

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
  };
}

export function areaCenter(a: Area): Point {
  return { x: (a.x + a.w / 2) * TILE, y: (a.y + a.h / 2) * TILE };
}
