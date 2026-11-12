/**
 * Furniture and props, drawn in code at 16 px/tile in a slight 3/4 view
 * (top surface + front face), outlined like the characters. Cached per kind/variant/frame.
 */
import { Rectangle, Texture } from "pixi.js";
import type { ObjectKind } from "../world/map.ts";
import { drawText, measureText } from "./font.ts";
import { C } from "./palette.ts";
import { PixelCanvas } from "./pixel.ts";
import { artSeason, foliage } from "./seasons.ts";

type Art = {
  w: number;
  h: number;
  frames?: number;
  /** pixel offset of the sprite bottom from the footprint bottom (positive = lower) */
  dy?: number;
  /** extra z for y-sorting (e.g. wall-mounted = very low) */
  z?: number;
  outline?: boolean;
  draw(pc: PixelCanvas, variant: number, frame: number): void;
};

const WOOD = { top: C.sand, mid: C.tan, front: C.wood, dark: C.bark };

function leafCluster(pc: PixelCanvas, cx: number, cy: number, r: number, sway: number) {
  pc.ellipse(cx - r + sway, cy - r, r * 2, r * 2, C.moss);
  pc.ellipse(cx - r + 1 + sway, cy - r, r * 2 - 2, r * 2 - 3, C.leaf);
  pc.set(cx - 1 + sway, cy - r + 2, C.lemon);
}

export const ART: Partial<Record<ObjectKind, Art>> = {
  fridge: {
    w: 16,
    h: 32,
    draw(pc) {
      pc.rect(1, 0, 14, 31, C.silver);
      pc.rect(1, 0, 14, 3, C.white);
      pc.vline(14, 3, 28, C.grey);
      pc.hline(1, 12, 14, C.grey);
      pc.vline(3, 6, 4, C.slate);
      pc.vline(3, 15, 6, C.slate);
      pc.set(9, 7, C.red); // magnet
      pc.set(11, 18, C.lemon);
      pc.set(6, 20, C.sky);
    },
  },
  counter: {
    w: 16,
    h: 24,
    draw(pc) {
      pc.rect(0, 0, 16, 8, C.cream);
      pc.hline(0, 7, 16, C.sand);
      pc.rect(0, 8, 16, 15, C.tan);
      pc.vline(15, 8, 15, C.wood);
      pc.vline(8, 9, 13, C.wood);
      pc.set(6, 14, C.cream);
      pc.set(10, 14, C.cream);
      pc.hline(0, 22, 16, C.bark);
    },
    outline: false,
  },
  coffee: {
    w: 12,
    h: 16,
    dy: -17,
    z: 20,
    draw(pc) {
      pc.rect(1, 0, 10, 4, C.ink);
      pc.rect(1, 4, 3, 11, C.ink);
      pc.rect(8, 4, 3, 11, C.ink);
      pc.rect(1, 13, 10, 2, C.dusk);
      pc.hline(2, 1, 8, C.slate);
      pc.set(9, 2, C.neon);
      pc.rect(4, 4, 4, 2, C.dusk);
      pc.rect(5, 10, 3, 3, C.white);
      pc.set(8, 11, C.white);
      pc.set(6, 10, C.bark);
    },
  },
  sink: {
    w: 14,
    h: 10,
    dy: -17,
    z: 20,
    outline: false,
    draw(pc) {
      pc.rect(1, 4, 12, 5, C.grey);
      pc.rect(2, 5, 10, 3, C.slate);
      pc.rect(6, 0, 2, 5, C.silver);
      pc.hline(6, 0, 4, C.silver);
      pc.set(9, 1, C.cyan);
    },
  },
  cooler: {
    w: 12,
    h: 26,
    draw(pc) {
      pc.rect(2, 0, 8, 9, C.cyan);
      pc.rect(3, 1, 6, 7, C.sky);
      pc.vline(3, 1, 6, C.cyan);
      pc.rect(1, 9, 10, 16, C.white);
      pc.vline(10, 9, 16, C.silver);
      pc.rect(4, 13, 4, 2, C.slate);
      pc.set(4, 13, C.red);
      pc.set(7, 13, C.sky);
    },
  },
  bistro: {
    w: 14,
    h: 18,
    draw(pc) {
      pc.vline(7, 8, 9, C.slate);
      pc.hline(4, 17, 7, C.slate);
      pc.ellipse(0, 0, 14, 9, C.white);
      pc.ellipse(1, 1, 12, 6, C.cream);
      pc.rect(3, 2, 3, 2, C.white); // mug
      pc.set(5, 2, C.bark);
    },
  },
  stool: {
    w: 8,
    h: 12,
    draw(pc, v) {
      pc.vline(2, 4, 7, C.bark);
      pc.vline(5, 4, 7, C.bark);
      pc.ellipse(0, 0, 8, 5, v ? C.red : C.sky);
    },
  },
  bookshelf: {
    w: 32,
    h: 36,
    draw(pc) {
      pc.rect(0, 0, 32, 35, C.bark);
      pc.rect(0, 0, 32, 2, C.wood);
      const books = [C.red, C.sky, C.amber, C.moss, C.plum, C.cream, C.navy, C.pink, C.clay];
      for (let shelf = 0; shelf < 3; shelf++) {
        const y = 3 + shelf * 11;
        pc.rect(2, y, 28, 9, C.cocoa);
        let x = 3;
        let i = shelf * 3;
        while (x < 28) {
          const w = 2 + ((i * 7) % 3 === 0 ? 1 : 0);
          const h = 6 + ((i * 5) % 3);
          pc.rect(x, y + 9 - h, w, h, books[i % books.length]!);
          pc.set(x, y + 9 - h, C.white);
          x += w + ((i * 3) % 5 === 0 ? 2 : 0);
          i++;
        }
        pc.hline(1, y + 9, 30, C.wood);
      }
    },
  },
  plantBig: {
    w: 16,
    h: 30,
    frames: 3,
    draw(pc, _v, f) {
      const sway = [0, 1, 0][f]!;
      pc.rect(3, 21, 10, 8, C.clay);
      pc.rect(2, 20, 12, 2, C.rust);
      pc.vline(12, 22, 7, C.rust);
      pc.vline(8, 10, 10, C.forest);
      leafCluster(pc, 6, 13, 4, sway);
      leafCluster(pc, 10, 9, 4, sway);
      leafCluster(pc, 7, 6, 3, sway);
      leafCluster(pc, 11, 16, 3, sway);
      pc.set(4 + sway, 17, C.moss);
    },
  },
  plant: {
    w: 14,
    h: 20,
    frames: 3,
    draw(pc, v, f) {
      const sway = [0, 1, 0][f]!;
      pc.rect(3, 13, 8, 6, v === 1 ? C.cream : C.clay);
      pc.hline(2, 12, 10, v === 1 ? C.white : C.rust);
      if (v === 1) {
        // snake plant
        for (const [x, h] of [
          [4, 9],
          [6, 12],
          [8, 10],
          [10, 8],
        ] as const) {
          pc.rect(x + (h > 9 ? sway : 0), 12 - h, 2, h, C.moss);
          pc.vline(x + (h > 9 ? sway : 0), 12 - h, h, C.leaf);
        }
      } else {
        leafCluster(pc, 5, 9, 4, sway);
        leafCluster(pc, 9, 7, 4, sway);
        if (v === 2) {
          pc.set(4 + sway, 6, C.pink);
          pc.set(9 + sway, 4, C.lemon);
          pc.set(11 + sway, 8, C.pink);
        }
      }
    },
  },
  sofa: {
    w: 48,
    h: 26,
    dy: 2,
    draw(pc) {
      const M = C.amber;
      const S = C.orange;
      const Lt = C.lemon;
      pc.rect(2, 0, 44, 11, S); // back
      pc.rect(3, 1, 42, 3, M);
      pc.rect(0, 6, 6, 18, M); // arms
      pc.rect(42, 6, 6, 18, M);
      pc.hline(0, 6, 6, Lt);
      pc.hline(42, 6, 6, Lt);
      pc.rect(6, 11, 36, 8, M); // seat
      pc.vline(18, 11, 8, S);
      pc.vline(30, 11, 8, S);
      pc.hline(6, 11, 36, Lt);
      pc.rect(2, 19, 44, 5, S);
      pc.rect(2, 24, 2, 2, C.bark);
      pc.rect(44, 24, 2, 2, C.bark);
      pc.rect(8, 7, 7, 5, C.pine); // cushion
      pc.hline(8, 7, 7, C.moss);
    },
  },
  coffeeTable: {
    w: 18,
    h: 14,
    draw(pc) {
      pc.rect(0, 0, 18, 8, WOOD.top);
      pc.rect(0, 8, 18, 3, WOOD.front);
      pc.rect(1, 11, 2, 3, C.bark);
      pc.rect(15, 11, 2, 3, C.bark);
      pc.rect(3, 2, 5, 4, C.white); // magazine
      pc.hline(4, 3, 3, C.sky);
      pc.rect(12, 2, 2, 3, C.red);
    },
  },
  armchair: {
    w: 18,
    h: 22,
    dy: 2,
    draw(pc) {
      pc.rect(2, 0, 14, 10, C.wine);
      pc.rect(3, 1, 12, 3, C.red);
      pc.rect(0, 6, 4, 14, C.red);
      pc.rect(14, 6, 4, 14, C.red);
      pc.rect(4, 10, 10, 6, C.red);
      pc.hline(4, 10, 10, C.pink);
      pc.rect(1, 16, 16, 4, C.wine);
      pc.rect(1, 20, 2, 2, C.bark);
      pc.rect(15, 20, 2, 2, C.bark);
    },
  },
  floorLamp: {
    w: 12,
    h: 32,
    draw(pc) {
      pc.vline(6, 9, 21, C.ink);
      pc.ellipse(2, 28, 9, 4, C.ink);
      pc.rect(2, 0, 9, 2, C.cream);
      pc.rect(1, 2, 11, 6, C.cream);
      pc.hline(1, 7, 11, C.sand);
      pc.hline(2, 0, 9, C.white);
    },
  },
  whiteboard: {
    w: 48,
    h: 26,
    dy: -1,
    z: -1000,
    draw(pc) {
      pc.rect(0, 0, 48, 22, C.silver);
      pc.rect(1, 1, 46, 20, C.white);
      pc.rect(6, 22, 36, 2, C.grey);
      pc.set(10, 21, C.red);
      pc.set(12, 21, C.sky);
      pc.set(14, 21, C.moss);
    },
  },
  meetingTable: {
    w: 96,
    h: 38,
    dy: 2,
    draw(pc) {
      pc.round(0, 0, 96, 28, WOOD.top);
      pc.hline(2, 1, 92, C.cream);
      pc.rect(1, 27, 94, 6, WOOD.front);
      pc.hline(1, 32, 94, C.bark);
      pc.rect(4, 33, 3, 5, C.bark);
      pc.rect(89, 33, 3, 5, C.bark);
      // papers, laptop, mugs
      pc.rect(10, 6, 8, 6, C.white);
      pc.hline(11, 8, 5, C.grey);
      pc.hline(11, 10, 4, C.grey);
      pc.rect(40, 8, 14, 9, C.slate);
      pc.rect(41, 9, 12, 6, C.ink);
      pc.hline(42, 10, 6, C.cyan);
      pc.hline(42, 12, 9, C.leaf);
      pc.rect(70, 14, 3, 3, C.white);
      pc.rect(80, 5, 7, 5, C.lemon);
      pc.rect(26, 17, 3, 3, C.red);
    },
  },
  meetingChair: {
    w: 12,
    h: 16,
    draw(pc, v) {
      if (v === 1) {
        pc.rect(1, 2, 10, 10, C.dusk);
        pc.hline(1, 2, 10, C.slate);
        pc.rect(5, 12, 2, 3, C.ink);
      } else {
        pc.rect(1, 0, 10, 6, C.dusk);
        pc.hline(1, 0, 10, C.slate);
        pc.rect(1, 6, 10, 5, C.slate);
        pc.rect(2, 11, 2, 4, C.ink);
        pc.rect(8, 11, 2, 4, C.ink);
      }
    },
  },
  arcade: {
    w: 16,
    h: 34,
    frames: 3,
    draw(pc, v, f) {
      const body = [C.plum, C.navy, C.wine][v % 3]!;
      const trim = [C.berry, C.sky, C.red][v % 3]!;
      pc.rect(1, 0, 14, 33, body);
      pc.rect(1, 0, 14, 4, trim);
      pc.hline(3, 1, 10, f === 0 ? C.slate : C.lemon);
      pc.rect(3, 6, 10, 9, C.night);
      if (f > 0) {
        const a = f === 1;
        pc.rect(4, 7, 8, 7, a ? C.navy : C.pine);
        pc.set(a ? 5 : 9, 9, C.lemon);
        pc.set(a ? 8 : 6, 11, C.neon);
        pc.hline(4, 13, 8, a ? C.leaf : C.cyan);
        pc.set(10, 8, C.white);
      } else {
        pc.rect(4, 7, 8, 7, C.ink);
      }
      pc.rect(0, 16, 16, 5, trim);
      pc.set(4, 17, C.red);
      pc.set(4, 16, C.red);
      pc.set(9, 18, C.lemon);
      pc.set(11, 18, C.sky);
      pc.rect(2, 21, 12, 11, body);
      pc.vline(14, 4, 29, C.night);
      pc.rect(6, 25, 4, 3, C.night);
    },
  },
  neon: {
    w: 48,
    h: 14,
    dy: -3,
    z: -1000,
    frames: 2,
    outline: false,
    draw(pc, _v, f) {
      const a = f === 1 ? C.neon : C.wine;
      const b = f === 1 ? C.cyan : C.navy;
      pc.rect(0, 0, 48, 14, C.night);
      pc.rect(1, 1, 46, 12, C.ink);
      // "PLAY" in chunky strokes
      const P = [
        "###..#.....###..#.#",
        "#..#.#....#...#.#.#",
        "###..#....#####..#.",
        "#....#....#...#..#.",
        "#....####.#...#..#.",
      ];
      pc.sprite(
        4,
        4,
        P.map((r) => r.replace(/#/g, "a")),
        { a },
      );
      pc.hline(26, 6, 18, b);
      pc.hline(26, 9, 14, b);
      pc.set(44, 9, b);
    },
  },
  pingpong: {
    w: 48,
    h: 32,
    dy: 0,
    draw(pc) {
      pc.rect(0, 0, 48, 24, C.navy);
      pc.rect(1, 1, 46, 22, C.sky);
      pc.hline(1, 11, 46, C.white);
      pc.vline(24, 0, 24, C.white);
      pc.rect(23, -2, 2, 26, C.silver);
      pc.rect(0, 24, 48, 3, C.navy);
      pc.rect(2, 27, 2, 5, C.ink);
      pc.rect(44, 27, 2, 5, C.ink);
      pc.set(10, 6, C.white);
    },
  },
  beanbag: {
    w: 16,
    h: 14,
    draw(pc, v) {
      const m = [C.sky, C.red, C.amber][v % 3]!;
      const s = [C.navy, C.wine, C.orange][v % 3]!;
      pc.ellipse(0, 2, 16, 12, s);
      pc.ellipse(1, 1, 14, 10, m);
      pc.ellipse(4, 3, 6, 4, C.white, 80);
    },
  },
  tv: {
    w: 32,
    h: 30,
    frames: 2,
    draw(pc, _v, f) {
      pc.rect(1, 18, 30, 11, C.bark);
      pc.hline(1, 18, 30, C.wood);
      pc.rect(4, 22, 9, 3, C.ink);
      pc.set(5, 23, C.leaf);
      pc.rect(18, 21, 10, 5, C.cocoa);
      pc.rect(2, 0, 28, 16, C.night);
      pc.rect(3, 1, 26, 14, f ? C.navy : C.pine);
      pc.rect(6, 9, 6, 4, C.leaf);
      pc.rect(17, 4 + f, 5, 5, C.lemon);
      pc.hline(3, 13, 26, C.moss);
      pc.rect(14, 16, 4, 2, C.ink);
    },
  },
  tree: {
    w: 36,
    h: 48,
    frames: 2,
    dy: 2,
    draw(pc, v, f) {
      const winter = artSeason() === "winter";
      pc.ellipse(4, 40, 28, 8, winter ? C.silver : C.forest, 255);
      pc.rect(15, 28, 6, 16, C.bark);
      pc.vline(16, 28, 15, C.wood);
      const s = f;
      if (winter) {
        // bare crown: trunk forks into branches, snow on the upper sides
        pc.rect(16, 10, 4, 20, C.bark);
        const branches = [
          [17, 22, -1, 10],
          [19, 18, 1, 11],
          [17, 14, -1, 8],
          [19, 11, 1, 7],
          [18, 9, 0, 6],
        ] as const;
        for (const [x0, y0, dir, len] of branches) {
          for (let i = 0; i < len; i++) {
            const x = x0 + dir * i + (dir === 0 ? 0 : s);
            const y = y0 - Math.floor(i * (dir === 0 ? 1 : 0.6));
            pc.set(x, y, C.cocoa);
            if (i % 2 === 1) pc.set(x, y - 1, C.white);
          }
        }
        return;
      }
      const fol = foliage(v);
      const dark = fol?.dark ?? (v === 1 ? C.pine : C.forest);
      const mid = fol?.mid ?? (v === 1 ? C.forest : C.moss);
      const lt = fol?.light ?? (v === 1 ? C.moss : C.leaf);
      pc.ellipse(2 + s, 8, 32, 26, dark);
      pc.ellipse(4 + s, 4, 28, 24, mid);
      pc.ellipse(8 + s, 2, 18, 16, lt);
      pc.ellipse(10 + s, 4, 6, 4, C.lemon, 255);
      pc.ellipse(20 + s, 18, 10, 8, mid);
      if (fol?.dot) {
        for (const [x, y] of [
          [9, 10],
          [22, 7],
          [15, 18],
          [26, 15],
          [7, 20],
          [18, 4],
        ] as const)
          pc.set(x + s, y, fol.dot);
      } else if (v === 1) {
        pc.set(10 + s, 14, C.red);
        pc.set(22 + s, 9, C.red);
        pc.set(17 + s, 21, C.red);
      }
    },
  },
  bench: {
    w: 32,
    h: 22,
    dy: 2,
    draw(pc) {
      pc.rect(1, 0, 30, 3, C.wood);
      pc.rect(1, 4, 30, 3, C.wood);
      pc.hline(1, 0, 30, C.tan);
      pc.hline(1, 4, 30, C.tan);
      pc.rect(2, 7, 2, 5, C.ink);
      pc.rect(28, 7, 2, 5, C.ink);
      pc.rect(0, 11, 32, 5, C.tan);
      pc.hline(0, 11, 32, C.sand);
      pc.hline(0, 15, 32, C.wood);
      pc.rect(2, 16, 2, 6, C.ink);
      pc.rect(28, 16, 2, 6, C.ink);
    },
  },
  flowers: {
    w: 32,
    h: 16,
    draw(pc, v) {
      pc.rect(0, 4, 32, 12, C.wood);
      pc.rect(1, 5, 30, 8, C.bark);
      pc.hline(0, 4, 32, C.tan);
      const cols = [
        [C.red, C.lemon, C.white],
        [C.pink, C.white, C.amber],
        [C.sky, C.lemon, C.berry],
      ][v % 3]!;
      for (let i = 0; i < 9; i++) {
        const x = 2 + i * 3 + (i % 2);
        const y = 2 + ((i * 5) % 4);
        pc.vline(x, y + 2, 4, C.moss);
        pc.set(x - 1, y + 4, C.leaf);
        pc.rect(x - 1, y, 3, 2, cols[i % 3]!);
        pc.set(x, y, C.lemon);
      }
    },
  },
  lampPost: {
    w: 10,
    h: 36,
    draw(pc) {
      pc.rect(3, 30, 4, 5, C.ink);
      pc.vline(4, 8, 22, C.ink);
      pc.vline(5, 8, 22, C.dusk);
      pc.rect(1, 2, 8, 6, C.ink);
      pc.rect(2, 3, 6, 4, C.lemon);
      pc.hline(0, 1, 10, C.ink);
      pc.hline(2, 0, 6, C.ink);
    },
  },
  parasol: {
    w: 34,
    h: 40,
    dy: 2,
    draw(pc) {
      pc.rect(9, 26, 16, 6, C.white);
      pc.rect(9, 32, 16, 2, C.silver);
      pc.rect(10, 34, 2, 6, C.slate);
      pc.rect(22, 34, 2, 6, C.slate);
      pc.vline(17, 10, 17, C.grey);
      pc.ellipse(0, 0, 34, 14, C.red);
      for (let y = 0; y < 14; y++) {
        for (let x = 0; x < 34; x++) {
          if (pc.get(x, y) !== 0 && Math.floor((x + 2) / 5) % 2 === 0) pc.set(x, y, C.white);
        }
      }
      pc.hline(3, 12, 28, C.wine);
      pc.rect(16, 0, 2, 2, C.lemon);
    },
  },
  serverRack: {
    w: 16,
    h: 30,
    frames: 2,
    draw(pc, _v, f) {
      pc.rect(1, 0, 14, 29, C.ink);
      pc.hline(1, 0, 14, C.slate);
      pc.vline(14, 1, 28, C.night);
      for (let u = 0; u < 5; u++) {
        const y = 3 + u * 5;
        pc.rect(3, y, 10, 3, C.slate);
        pc.hline(3, y, 10, C.grey);
        const on = (u + f) % 2 === 0;
        pc.set(4, y + 1, on ? C.leaf : C.moss);
        pc.set(6, y + 1, (u * 3 + f) % 3 === 0 ? C.amber : C.night);
        pc.hline(9, y + 1, 3, C.night);
      }
      pc.rect(2, 28, 2, 1, C.night);
      pc.rect(12, 28, 2, 1, C.night);
    },
  },
  printer: {
    w: 16,
    h: 20,
    draw(pc) {
      pc.rect(0, 6, 16, 13, C.silver);
      pc.rect(0, 6, 16, 2, C.white);
      pc.rect(2, 10, 12, 3, C.ink);
      pc.rect(3, 1, 10, 6, C.white);
      pc.hline(4, 3, 7, C.grey);
      pc.set(13, 15, C.leaf);
      pc.vline(15, 8, 11, C.grey);
    },
  },
  bush: {
    w: 16,
    h: 16,
    dy: 1,
    draw(pc, v) {
      const season = artSeason();
      const fol = foliage(v);
      pc.ellipse(0, 2, 16, 14, fol?.dark ?? C.forest);
      pc.ellipse(1, 1, 13, 11, fol?.mid ?? C.moss);
      pc.ellipse(3, 2, 7, 5, season === "winter" ? C.white : (fol?.light ?? C.leaf));
      if (season === "winter") pc.hline(2, 1, 11, C.white);
      if (v === 1) {
        pc.set(4, 8, C.pink);
        pc.set(10, 5, C.pink);
        pc.set(8, 11, C.white);
      }
      if (v === 2) {
        pc.set(5, 7, C.red);
        pc.set(11, 9, C.red);
      }
    },
  },
  // ---- bar ------------------------------------------------------------------------------
  barCounter: {
    w: 96,
    h: 26,
    dy: 2,
    draw(pc) {
      pc.rect(0, 0, 96, 8, C.wood); // polished top
      pc.hline(0, 0, 96, C.tan);
      pc.hline(2, 2, 92, C.sand);
      pc.rect(0, 8, 96, 16, C.cocoa); // panelled front
      for (let x = 4; x < 92; x += 16) {
        pc.rect(x, 11, 12, 10, C.bark);
        pc.hline(x, 11, 12, C.wood);
      }
      pc.hline(0, 21, 96, C.amber); // brass foot rail
      pc.hline(0, 22, 96, C.orange);
      pc.rect(0, 23, 96, 1, C.night);
      // glasses and a beer mat on the counter
      pc.rect(14, 2, 3, 4, C.white);
      pc.rect(14, 3, 3, 3, C.amber);
      pc.rect(58, 3, 5, 3, C.red);
      pc.rect(59, 1, 3, 4, C.cyan);
      pc.rect(82, 2, 3, 4, C.white);
      pc.rect(82, 4, 3, 2, C.amber);
    },
  },
  barBack: {
    w: 16,
    h: 24,
    draw(pc) {
      pc.rect(0, 0, 16, 8, C.bark);
      pc.hline(0, 0, 16, C.wood);
      pc.rect(0, 8, 16, 15, C.cocoa);
      pc.vline(8, 9, 13, C.night);
      pc.set(6, 15, C.amber);
      pc.set(10, 15, C.amber);
      pc.hline(0, 22, 16, C.night);
    },
    outline: false,
  },
  beerTap: {
    w: 14,
    h: 14,
    dy: -17,
    z: 20,
    draw(pc) {
      pc.rect(1, 2, 12, 3, C.amber); // tap bar
      pc.hline(1, 2, 12, C.lemon);
      for (const x of [2, 6, 10]) {
        pc.rect(x, 0, 2, 2, [C.red, C.lemon, C.navy][x % 3]!); // handles
        pc.vline(x + 1, 5, 3, C.silver);
      }
      pc.rect(1, 11, 12, 2, C.silver); // drip tray
      pc.rect(5, 8, 3, 4, C.white);
      pc.rect(5, 9, 3, 3, C.amber);
    },
  },
  barStool: {
    w: 10,
    h: 16,
    draw(pc, v) {
      pc.vline(3, 5, 10, C.amber);
      pc.vline(6, 5, 10, C.amber);
      pc.hline(2, 10, 6, C.orange);
      pc.ellipse(0, 0, 10, 6, v ? C.wine : C.cocoa);
      pc.hline(2, 1, 6, v ? C.red : C.wood);
    },
  },
  bottleShelf: {
    w: 48,
    h: 38,
    draw(pc) {
      pc.rect(0, 0, 48, 37, C.cocoa);
      pc.rect(0, 0, 48, 2, C.bark);
      const bottles = [C.moss, C.amber, C.wine, C.sky, C.leaf, C.clay, C.white, C.orange];
      for (let shelf = 0; shelf < 3; shelf++) {
        const y = 3 + shelf * 11;
        pc.rect(2, y, 44, 9, C.night);
        for (let i = 0; i < 9; i++) {
          const x = 4 + i * 5;
          const c = bottles[(i * 3 + shelf * 5) % bottles.length]!;
          const h = 6 + ((i + shelf) % 2);
          pc.rect(x, y + 9 - h + 2, 3, h - 2, c);
          pc.rect(x + 1, y + 9 - h, 1, 2, c);
          pc.set(x, y + 9 - h + 3, C.white);
        }
        pc.hline(1, y + 9, 46, C.bark);
      }
      pc.rect(0, 35, 48, 2, C.bark);
    },
  },
  standingTable: {
    w: 14,
    h: 24,
    draw(pc) {
      pc.ellipse(4, 21, 7, 3, C.ink);
      pc.vline(7, 6, 16, C.ink);
      pc.vline(6, 6, 16, C.slate);
      pc.ellipse(0, 0, 14, 7, C.bark);
      pc.ellipse(1, 0, 12, 5, C.wood);
      pc.rect(3, -1, 2, 3, C.amber); // a beer and a candle
      pc.set(3, -2, C.white);
      pc.set(4, -2, C.white);
      pc.set(9, 1, C.cream);
      pc.set(9, 0, C.lemon);
    },
  },
  neonBeer: {
    w: 48,
    h: 14,
    dy: -13,
    z: -1000,
    frames: 2,
    outline: false,
    draw(pc, _v, f) {
      const on = f === 1;
      pc.rect(0, 0, 48, 14, C.night);
      pc.rect(1, 1, 46, 12, C.ink);
      // a mug + "BAR"
      const m = on ? C.amber : C.cocoa;
      const foam = on ? C.white : C.slate;
      pc.rect(4, 4, 7, 2, foam);
      pc.rect(4, 6, 7, 5, m);
      pc.vline(11, 6, 3, m);
      pc.set(12, 6, m);
      pc.set(12, 8, m);
      drawText(pc, 17, 5, "BAR", on ? C.pink : C.plum);
      pc.hline(17, 11, 26, on ? C.neon : C.wine);
    },
  },
  // ---- weed shop + smokers' corner ----------------------------------------------------------
  shopCounter: {
    w: 48,
    h: 26,
    dy: 2,
    draw(pc) {
      pc.rect(0, 2, 48, 8, C.white);
      pc.hline(0, 2, 48, C.silver);
      pc.rect(0, 10, 48, 14, C.forest);
      for (let x = 2; x < 46; x += 4) pc.vline(x, 12, 10, C.pine);
      pc.hline(0, 23, 48, C.night);
      // till, a jar and a little leaf sticker
      pc.rect(30, -2, 12, 9, C.slate);
      pc.rect(31, -1, 10, 3, C.ink);
      pc.hline(32, 0, 6, C.leaf);
      pc.rect(32, 4, 8, 2, C.grey);
      pc.rect(8, 1, 5, 6, C.cyan);
      pc.rect(9, 0, 3, 1, C.leaf);
      pc.rect(9, 3, 3, 3, C.moss);
      pc.set(22, 16, C.leaf);
      pc.set(21, 15, C.leaf);
      pc.set(23, 15, C.leaf);
      pc.set(22, 14, C.leaf);
      pc.set(22, 17, C.moss);
    },
  },
  jarShelf: {
    w: 48,
    h: 36,
    draw(pc, v) {
      pc.rect(0, 0, 48, 35, v ? C.sand : C.tan);
      pc.rect(0, 0, 48, 2, C.wood);
      const lids = [C.leaf, C.moss, C.lemon, C.amber, C.pine];
      for (let shelf = 0; shelf < 3; shelf++) {
        const y = 3 + shelf * 11;
        pc.rect(2, y, 44, 9, C.cream);
        for (let i = 0; i < 6; i++) {
          const x = 4 + i * 7;
          pc.rect(x, y + 3, 5, 6, C.cyan); // glass
          pc.rect(x + 1, y + 5, 3, 4, (i + shelf + v) % 3 ? C.moss : C.leaf); // buds
          pc.rect(x, y + 2, 5, 1, lids[(i + shelf * 2 + v) % lids.length]!);
          pc.set(x + 3, y + 4, C.white);
        }
        pc.hline(1, y + 9, 46, C.wood);
      }
    },
  },
  greenCross: {
    w: 14,
    h: 14,
    dy: -13,
    z: -1000,
    frames: 2,
    outline: false,
    draw(pc, _v, f) {
      const on = f === 1;
      const c = on ? C.leaf : C.forest;
      pc.rect(0, 0, 14, 14, C.night);
      pc.rect(5, 2, 4, 10, c);
      pc.rect(2, 5, 10, 4, c);
      if (on) {
        pc.vline(6, 3, 8, C.lemon);
        pc.hline(3, 6, 8, C.lemon);
      }
    },
  },
  openSign: {
    w: 30,
    h: 11,
    dy: -13,
    z: -1000,
    frames: 2,
    outline: false,
    draw(pc, _v, f) {
      const open = f === 1;
      const text = open ? "OPEN" : "CLOSED";
      pc.rect(0, 0, 30, 11, C.night);
      pc.rect(1, 1, 28, 9, open ? C.ink : C.cocoa);
      drawText(pc, Math.floor((30 - measureText(text)) / 2), 3, text, open ? C.leaf : C.red);
    },
  },
  ashtray: {
    w: 10,
    h: 20,
    draw(pc) {
      pc.ellipse(2, 17, 7, 3, C.ink);
      pc.rect(3, 4, 4, 14, C.grey);
      pc.vline(6, 4, 14, C.slate);
      pc.ellipse(0, 0, 10, 5, C.silver);
      pc.ellipse(2, 1, 6, 3, C.slate);
      pc.set(3, 1, C.white); // butts
      pc.set(6, 2, C.cream);
      pc.set(7, 2, C.orange);
    },
  },
  // ---- the two residents without an agent ------------------------------------------------
  stove: {
    w: 16,
    h: 24,
    frames: 2,
    outline: false,
    draw(pc, _v, f) {
      pc.rect(0, 0, 16, 8, C.silver);
      pc.rect(1, 1, 14, 6, C.ink);
      pc.ellipse(2, 2, 6, 4, C.slate);
      pc.ellipse(9, 2, 6, 4, f ? C.orange : C.red);
      pc.set(11, 3, f ? C.lemon : C.amber);
      pc.ellipse(1, 0, 8, 5, C.slate);
      pc.ellipse(2, 1, 6, 3, C.cream);
      pc.set(4, 1, f ? C.amber : C.lemon);
      pc.set(5, 2, C.lemon);
      pc.hline(9, 2, 4, C.bark);
      pc.rect(0, 8, 16, 15, C.silver);
      pc.rect(2, 11, 12, 8, C.grey);
      pc.rect(3, 12, 10, 6, C.ink);
      pc.hline(3, 12, 10, f ? C.orange : C.wine);
      pc.hline(4, 10, 8, C.slate);
      pc.vline(15, 8, 15, C.grey);
      pc.hline(0, 22, 16, C.bark);
    },
  },
  headDesk: {
    w: 48,
    h: 30,
    dy: 2,
    draw(pc) {
      pc.rect(0, 0, 48, 13, C.wood);
      pc.hline(0, 0, 48, C.tan);
      pc.rect(0, 13, 48, 13, C.bark);
      pc.hline(0, 13, 48, C.cocoa);
      pc.rect(2, -8, 13, 10, C.ink);
      pc.rect(7, 2, 3, 2, C.slate);
      pc.rect(36, 3, 8, 6, C.white);
      pc.hline(37, 5, 6, C.silver);
      pc.hline(37, 7, 6, C.silver);
      pc.rect(37, 1, 6, 3, C.cream);
      pc.rect(29, 4, 3, 4, C.red);
      pc.rect(28, 8, 5, 1, C.ink);
      pc.rect(1, 16, 46, 8, C.amber);
      pc.hline(1, 23, 46, C.orange);
      drawText(pc, Math.floor((48 - measureText("HEAD OF DEV")) / 2), 18, "HEAD OF DEV", C.cocoa);
      pc.rect(1, 26, 3, 4, C.night);
      pc.rect(44, 26, 3, 4, C.night);
    },
  },
  timeClock: {
    w: 12,
    h: 18,
    dy: -3,
    z: -1000,
    frames: 2,
    draw(pc, _v, f) {
      pc.rect(0, 0, 12, 18, C.slate);
      pc.rect(1, 1, 10, 16, C.grey);
      pc.ellipse(2, 2, 8, 8, C.white);
      pc.set(6, 3, C.ink);
      pc.set(6, 4, C.ink);
      pc.set(6, 5, C.ink);
      pc.set(f ? 7 : 5, f ? 6 : 5, C.red);
      pc.rect(3, 11, 6, 2, C.ink);
      pc.rect(4, 8, 4, 4, C.cream);
      pc.hline(4, 9, 4, C.red);
      pc.rect(2, 14, 2, 2, f ? C.neon : C.forest);
      pc.rect(8, 14, 2, 2, C.red);
    },
  },
  salesStand: {
    w: 32,
    h: 28,
    dy: 2,
    draw(pc) {
      pc.rect(0, 0, 32, 8, C.tan);
      pc.hline(0, 0, 32, C.sand);
      pc.hline(0, 7, 32, C.wood);
      pc.rect(20, -4, 9, 8, C.slate);
      pc.rect(21, -3, 7, 3, C.ink);
      pc.hline(22, -2, 4, C.neon);
      pc.rect(3, 2, 5, 4, C.white);
      pc.rect(5, 1, 5, 4, C.sky);
      pc.hline(6, 2, 3, C.white);
      pc.ellipse(13, 2, 4, 3, C.amber);
      pc.set(14, 1, C.lemon);
      for (let x = 0; x < 32; x += 4) {
        pc.rect(x, 8, 2, 16, C.red);
        pc.rect(x + 2, 8, 2, 16, C.white);
      }
      pc.rect(4, 11, 24, 9, C.navy);
      drawText(pc, Math.floor((32 - measureText("DEALS")) / 2), 13, "DEALS", C.lemon);
      pc.hline(0, 23, 32, C.wine);
      pc.rect(1, 24, 2, 4, C.bark);
      pc.rect(29, 24, 2, 4, C.bark);
    },
  },
};

const cache = new Map<string, Texture[]>();

/** All frames of a furniture piece (single-frame pieces return one texture). */
export function furnitureFrames(kind: ObjectKind, variant = 0): Texture[] | null {
  const art = ART[kind];
  if (!art) return null;
  const key = `${kind}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const n = art.frames ?? 1;
  const pad = 2;
  const fw = art.w + pad * 2;
  const fh = art.h + pad * 2;
  const pc = new PixelCanvas(fw * n, fh);
  for (let f = 0; f < n; f++) {
    pc.at(f * fw + pad, pad);
    art.draw(pc, variant, f);
    pc.at(0, 0);
    if (art.outline !== false) pc.outline(f * fw, 0, fw, fh);
  }
  const base = Texture.from(pc.toCanvas());
  const frames = Array.from(
    { length: n },
    (_, f) => new Texture({ source: base.source, frame: new Rectangle(f * fw, 0, fw, fh) }),
  );
  cache.set(key, frames);
  return frames;
}

export function furnitureMeta(kind: ObjectKind) {
  const art = ART[kind];
  return art ? { w: art.w, h: art.h, dy: art.dy ?? 0, z: art.z ?? 0, pad: 2 } : null;
}
