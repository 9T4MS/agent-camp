/**
 * Head GIFs: a person can pick any GIF from giphy.com (connector `agent-office gif <link>`),
 * and it floats over their main character (their oldest session). Activity bubbles and
 * markers stay on top; when a bubble pops up the GIF eases up to make room.
 *
 * GIFs are fetched from Giphy's CDN (CORS enabled, the 100w rendition, no referrer, no
 * cookies), decoded once per id and shared by everyone showing it. Long GIFs are thinned to
 * a texture budget. Frames are drawn on a plain Sprite driven by the office clock.
 * `?gifs=0` turns them off for that screen (main.ts never creates this).
 */
import { giphyGifUrl } from "@agent-office/protocol";
import { Container, Sprite, type Texture } from "pixi.js";
import { GifSource } from "pixi.js/gif";
import type { OfficeModel } from "../state/officeModel.ts";
import type { CharacterManager, SessionCharacter } from "./characters.ts";

/** Box the GIF is fitted into, in world px (a character is ~24 px tall). */
export const GIF_MAX_W = 36;
export const GIF_MAX_H = 30;
/** Gap between the top of the head and the GIF. */
const GIF_GAP = 3;
/** Refuse absurdly large files (the 100w rendition is usually a few hundred KB). */
const MAX_BYTES = 4 * 1024 * 1024;
/**
 * Decoded frames are full RGBA canvases (w × h × 4 bytes each); past this budget a GIF keeps
 * only every n-th frame (same total duration), so a long GIF can't eat the kiosk iPad's memory.
 */
export const MAX_TEXTURE_BYTES = 6 * 1024 * 1024;
/** A failed load is retried after this long. */
const RETRY_MS = 60_000;

export type GifAnim = {
  textures: Texture[];
  /** cumulative end time of each frame in ms */
  ends: number[];
  duration: number;
  width: number;
  height: number;
  destroy(): void;
};

export type GifLoader = (id: string) => Promise<GifAnim>;

/** Browsers show frames with a delay of 0-10 ms for 100 ms; so do we. */
export function frameEnds(delays: readonly number[]): number[] {
  let t = 0;
  return delays.map((d) => {
    t += d > 10 ? d : 100;
    return t;
  });
}

/**
 * Which frames to keep so that at most `max` remain, spread evenly, and their new end times:
 * a kept frame lasts until the next kept one starts, so the loop keeps its length.
 */
export function thinFrames(
  ends: readonly number[],
  max: number,
): { keep: number[]; ends: number[] } {
  const n = ends.length;
  const k = Math.max(1, Math.min(n, Math.floor(max)));
  const keep: number[] = [];
  for (let i = 0; i < k; i++) keep.push(Math.floor((i * n) / k));
  const out = keep.map((_, j) => ends[(j + 1 < k ? keep[j + 1]! : n) - 1]!);
  return { keep, ends: out };
}

/** Index of the frame showing at `ms` into a looping animation. */
export function frameAt(ends: readonly number[], ms: number): number {
  const duration = ends[ends.length - 1] ?? 0;
  if (duration <= 0) return 0;
  const t = ((ms % duration) + duration) % duration;
  let lo = 0;
  let hi = ends.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid]! > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Scale that fits w x h into the GIF box (never 0). */
export function fitScale(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.min(GIF_MAX_W / w, GIF_MAX_H / h);
}

export const loadGiphy: GifLoader = async (id) => {
  // like the <img> previews: Giphy learns neither the office URL nor gets any cookies
  const res = await fetch(giphyGifUrl(id, 100), {
    mode: "cors",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`giphy ${id}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error(`giphy ${id}: too large`);
  // smooth scaling: a photo-like GIF shrunk with "nearest" looks like noise
  const src = GifSource.from(buf, { scaleMode: "linear" });
  const all = frameEnds(src.frames.map((f) => f.end - f.start));
  const frameBytes = Math.max(1, src.width * src.height * 4);
  const { keep, ends } = thinFrames(all, MAX_TEXTURE_BYTES / frameBytes);
  const kept = new Set(keep);
  // free the dropped frames right away; the kept ones go with destroy()
  src.textures.forEach((t, i) => {
    if (!kept.has(i)) t.destroy(true);
  });
  const textures = keep.map((i) => src.textures[i]!);
  return {
    textures,
    ends,
    duration: ends[ends.length - 1] ?? 0,
    width: src.width,
    height: src.height,
    destroy: () => {
      for (const t of textures) t.destroy(true);
    },
  };
};

type Entry = { anim: GifAnim | null; failedAt: number; loading: boolean; users: number };
type Shown = { gif: string; sprite: Sprite; lift: number };

export class HeadGifs {
  readonly layer = new Container();
  private entries = new Map<string, Entry>();
  /** personId -> sprite */
  private shown = new Map<string, Shown>();
  private time = 0;

  constructor(
    parent: Container,
    private readonly model: OfficeModel,
    private readonly chars: CharacterManager,
    private readonly load: GifLoader = loadGiphy,
    private readonly now: () => number = Date.now,
  ) {
    this.layer.label = "head-gifs";
    // under bubbles, markers and the selection arrow (added to fx later)
    parent.addChildAt(this.layer, 0);
  }

  /** Bring sprites in line with the model (call after every batch of model changes). */
  sync() {
    for (const [personId, s] of this.shown) {
      const p = this.model.people.get(personId);
      if (!p || p.gif !== s.gif) this.drop(personId);
    }
    for (const p of this.model.people.values()) {
      if (!p.gif || this.shown.has(p.personId)) continue;
      const sprite = new Sprite();
      sprite.anchor.set(0.5, 1);
      sprite.visible = false;
      sprite.label = `gif:${p.personId}`;
      this.layer.addChild(sprite);
      this.shown.set(p.personId, { gif: p.gif, sprite, lift: 0 });
      this.use(p.gif);
    }
  }

  /** The character a person's GIF floats over: their oldest visible session. */
  anchorOf(personId: string): SessionCharacter | null {
    let best: SessionCharacter | null = null;
    for (const c of this.chars.chars.values()) {
      if (c.personId !== personId || c.removed || !c.sprite.visible || c.mode === "zapped")
        continue;
      if (!best || c.startedAt < best.startedAt) best = c;
    }
    return best;
  }

  update(dt: number) {
    this.time += dt;
    for (const [personId, s] of this.shown) {
      const e = this.entries.get(s.gif);
      if (e && !e.anim && !e.loading && this.now() - e.failedAt >= RETRY_MS) this.fetch(s.gif, e);
      const anim = e?.anim;
      const c = anim ? this.anchorOf(personId) : null;
      if (!anim || !c) {
        s.sprite.visible = false;
        continue;
      }
      const tex = anim.textures[frameAt(anim.ends, this.time * 1000)];
      if (tex && s.sprite.texture !== tex) s.sprite.texture = tex;
      s.sprite.scale.set(fitScale(anim.width, anim.height));
      const headY = c.y - (c.mode === "seated" || c.anim === "sitFront" ? 21 : 24);
      let bottom = headY - GIF_GAP;
      // make room for an activity bubble (eased so it doesn't jump)
      if (c.bubble.visible) bottom = Math.min(bottom, c.bubble.y - c.bubble.height - 1);
      const want = headY - GIF_GAP - bottom;
      s.lift += (want - s.lift) * Math.min(1, dt * 10);
      s.sprite.position.set(Math.round(c.x), Math.round(headY - GIF_GAP - s.lift));
      s.sprite.visible = true;
    }
  }

  private use(id: string) {
    let e = this.entries.get(id);
    if (!e) {
      e = { anim: null, failedAt: 0, loading: false, users: 0 };
      this.entries.set(id, e);
    }
    e.users++;
    if (!e.anim && !e.loading && this.now() - e.failedAt >= RETRY_MS) this.fetch(id, e);
  }

  private fetch(id: string, e: Entry) {
    e.loading = true;
    this.load(id).then(
      (anim) => {
        e.loading = false;
        if (e.users > 0) e.anim = anim;
        else {
          anim.destroy();
          this.entries.delete(id);
        }
      },
      (err) => {
        e.loading = false;
        e.failedAt = this.now();
        console.warn("head gif failed", err);
      },
    );
  }

  private drop(personId: string) {
    const s = this.shown.get(personId);
    if (!s) return;
    this.shown.delete(personId);
    this.layer.removeChild(s.sprite);
    s.sprite.destroy();
    const e = this.entries.get(s.gif);
    if (!e) return;
    e.users--;
    if (e.users <= 0 && !e.loading) {
      e.anim?.destroy();
      this.entries.delete(s.gif);
    }
  }
}
