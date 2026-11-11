/**
 * Giphy GIFs over a person's head. Only the Giphy media id travels over the wire (never a
 * free-form URL), and viewers build the media URL themselves, so nobody can make every
 * office screen load an arbitrary address.
 */
import { z } from "zod";

/** A Giphy media id, e.g. "JIX9t2j0ZTN9S". */
export const GiphyId = z.string().regex(/^[A-Za-z0-9]{4,64}$/);
export type GiphyId = z.infer<typeof GiphyId>;

const isId = (s: string) => GiphyId.safeParse(s).success;

/**
 * Giphy media id from anything a person may paste: a page link
 * (`https://giphy.com/gifs/cat-funny-JIX9t2j0ZTN9S`, `/stickers/...`, `/embed/...`), a media
 * link (`https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif`, `media1.giphy.com`,
 * `i.giphy.com/JIX9t2j0ZTN9S.webp`, links with a `v1.…` token segment) or the bare id.
 * Returns null when it is not a Giphy GIF (short `gph.is` links can't be resolved offline).
 */
export function parseGiphyId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (isId(raw)) return raw;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "giphy.com" && !host.endsWith(".giphy.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);

  // media hosts: /media/<id>/<file>, /media/v1.<token>/<id>/<file>, /<id>.gif, /<id>/giphy.gif
  if (host !== "giphy.com" && host !== "www.giphy.com") {
    const segs = parts.filter((p) => p !== "media" && !p.startsWith("v1."));
    const last = segs[segs.length - 1] ?? "";
    if (segs.length === 1) {
      // i.giphy.com/<id>.gif; a lone file name like "giphy.gif" is no id
      const id = last.replace(/\.(gif|webp|mp4)$/i, "");
      return host === "i.giphy.com" && id !== last && isId(id) ? id : null;
    }
    const id = segs[segs.length - 2] ?? "";
    return isId(id) ? id : null;
  }

  // page links: /gifs/<slug>-<id>, /stickers/<slug>-<id>, /embed/<id>, /clips/... (not GIFs)
  const kind = parts[0];
  if (kind !== "gifs" && kind !== "stickers" && kind !== "embed") return null;
  let seg = parts[1] ?? "";
  // /gifs/<user>/<slug>-<id> (channel links)
  if (parts.length >= 3 && kind === "gifs" && parts[2] !== "html5" && parts[2] !== "fullscreen")
    seg = parts[2]!;
  const id = seg.split("-").pop() ?? "";
  return isId(id) ? id : null;
}

/**
 * Media URL a viewer loads for a Giphy id (CORS enabled): the 200 px wide rendition for the
 * card previews, the 100 px one (`fixed_width_small`) for the canvas, plenty for a 36×30
 * world px box and a quarter of the texture memory.
 */
export function giphyGifUrl(id: string, width: 100 | 200 = 200): string {
  return `https://media.giphy.com/media/${encodeURIComponent(id)}/${width}w.gif`;
}

/** Page link for a Giphy id (shown on the person card / in the CLI). */
export function giphyPageUrl(id: string): string {
  return `https://giphy.com/gifs/${encodeURIComponent(id)}`;
}
