/**
 * Office renderer entry. URL params:
 *   ?demo=busy|one|empty|join|party|feierabend (or 1)  local fake feed, no server; &seed=, &people=, &sessions=
 *                 (party: office life moments fast: chats, coffee, /clear zap, records, pizza;
 *                  feierabend: Friday 17:30 happy hour, bar + weed shop + smokers' corner)
 *   ?feierabend=1  the feierabend setup on any feed (17:30 happy hour, lively, busy shop)
 *   ?bar=open|closed  ?shop=open|closed  ignore the opening hours (17-02 / 10-20)
 *   ?weather=sun|clouds|rain|snow  force the weather (default: changes hour by hour, seeded)
 *   ?season=winter|spring|summer|autumn  force the season (default: the local month)
 *   ?lively=1     office life at party speed (chattier, waits count 10x, pizza drone in 3 s)
 *   ?key=...      viewer key passed through to /ws/viewer
 *   ?kiosk=1      iPad kiosk (no cursor, big text, no panels, wake lock, 30 fps, auto-tour,
 *                 reloads itself right after a deploy)
 *   ?recorder=1   upload a timelapse PNG every 15 min (&recordEvery=ms to override)
 *   ?nohud=1      hide all DOM overlays     ?zoom=fit|<n>  initial zoom
 *   ?hour=0..24   force the time of day     ?gallery=1     art gallery (dev)
 *   ?focus=<personId>  start focused on that person's desk pod
 *   ?look=tracht|b64:<base64url AvatarSpec JSON>  demo: the first person wears this avatar
 *   ?gallery=look[&look=…][&gscale=N]  detailed-look gallery (sets window.__galleryReady)
 */
import "./ui/theme.css";
import "./ui/office.css";
import {
  type AvatarEditResponse,
  type AvatarSpec,
  MESSAGE_MAX_ROWS,
  MESSAGE_RETENTION_MS,
  type MessageRecord,
  type PartyEvent,
  type PersonDayResponse,
  parseViewerMessage,
  type SendMessageRequest,
  type SendMessageResponse,
  type ServerToViewer,
} from "@agent-office/protocol";
import { Application, TextureStyle } from "pixi.js";
import { CHAR_H, CHAR_RES, CHAR_W, lookFor, lookPreview } from "./art/characters.ts";
import { fitText } from "./art/font.ts";
import { trophyCanvas } from "./art/fun.ts";
import { C } from "./art/palette.ts";
import { avatarPortrait } from "./art/party.ts";
import { setArtSeason } from "./art/seasons.ts";
import { Camera } from "./camera.ts";
import { CHANGELOG } from "./changelog.ts";
import { DemoFeed, parseDemoMode, parseLookParam } from "./demo/demoFeed.ts";
import { Hud, type PokeRequest, type PokeResult } from "./hud.ts";
import { keepAwake, reloadInto, watchForNewBuild } from "./kiosk.ts";
import { MessagesClient } from "./net/messages.ts";
import { connectViewer, loginIfLoggedOut } from "./net/viewer.ts";
import { PartyPanel } from "./partyPanel.ts";
import { registerServiceWorker } from "./pwa.ts";
import { captureSnapshot, startRecorder } from "./recorder.ts";
import {
  loadSeen,
  mayAutoReload,
  newVersionLabel,
  notesKey,
  saveSeen,
  shouldCelebrate,
} from "./release.ts";
import { MessageModel } from "./state/messageModel.ts";
import { type ModelChange, OfficeModel } from "./state/officeModel.ts";
import { Celebration } from "./ui/celebration.ts";
import { MessagesPanel, storedMessageRead } from "./ui/messages.ts";
import { Minimap } from "./ui/minimap.ts";
import { OfficeCat } from "./world/cat.ts";
import { CharacterManager } from "./world/characters.ts";
import { Effects } from "./world/effects.ts";
import { OfficeLife } from "./world/life.ts";
import { SEASONS, type Season, seasonFor } from "./world/lifeRules.ts";
import { Living } from "./world/living.ts";
import {
  type AreaName,
  BASE_POD_ROWS,
  buildOfficeMap,
  OFFICE_COLS,
  POD_COLS,
  podDeskSpan,
  podOrigin,
  podRowsFor,
} from "./world/map.ts";
import { OfficeScene } from "./world/office.ts";
import { PartyWorld } from "./world/party.ts";
import { OfficeQueen } from "./world/queen.ts";

type OfficeApi = {
  ready: boolean;
  fps(): number;
  /** average ms per frame spent in update / render over the last second */
  frameMs(): { update: number; render: number };
  model: OfficeModel;
  camera: {
    zoomToFit(): void;
    focusArea(name: AreaName | "all"): void;
    /** center on a tile at a zoom (screenshots) */
    lookAt(tileX: number, tileY: number, zoom: number): void;
    focusPerson(personId: string, zoom?: number): boolean;
  };
  injectEvent(msg: unknown): boolean;
  /** open a session's agent card (like clicking its character); false if unknown */
  openSession(sessionId: string): boolean;
  snapshotPng(): Promise<string | null>;
  characters(): number;
  /** slow down / freeze the world clock (screenshots of short moments); 1 = normal */
  setSpeed(k: number): void;
};
declare global {
  interface Window {
    __office: OfficeApi;
  }
}

const params = new URLSearchParams(location.search);
const flag = (k: string) => params.get(k) === "1" || params.get(k) === "true";
const kiosk = flag("kiosk");
const nohud = flag("nohud");
const recorder = flag("recorder");
const demo = parseDemoMode(params.get("demo"));
const zoomParam = params.get("zoom");
const hourParam = params.get("hour");
const key = params.get("key");

registerServiceWorker();

async function boot() {
  TextureStyle.defaultOptions.scaleMode = "nearest";
  const host = document.getElementById("app")!;
  if (kiosk) document.body.classList.add("kiosk");
  if (nohud) document.body.classList.add("nohud");

  const app = new Application();
  await app.init({
    resizeTo: host,
    background: C.pine,
    antialias: false,
    roundPixels: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    preference: "webgl",
  });
  host.appendChild(app.canvas);
  if (kiosk) app.ticker.maxFPS = 30;

  if (params.has("gallery")) {
    const { showGallery } = await import("./dev/gallery.ts");
    showGallery(app);
    window.__office = { ready: true } as OfficeApi;
    return;
  }

  const model = new OfficeModel();
  const seasonParam = params.get("season") as Season | null;
  const season =
    seasonParam && SEASONS.includes(seasonParam)
      ? seasonParam
      : seasonFor(new Date().getMonth() + 1);
  setArtSeason(season);
  const scene = new OfficeScene(buildOfficeMap(BASE_POD_ROWS));
  app.stage.addChild(scene.root);
  const effects = new Effects(scene.fx);
  const chars = new CharacterManager(scene, model, effects);
  const partyWorld = new PartyWorld(scene, chars, model);
  // Friday after work (`?demo=feierabend`, or `?feierabend=1` on a live feed): happy hour at
  // 17:30, office life at party speed, the weed shop sells more
  const feierabend = demo === "feierabend" || flag("feierabend");
  const party = demo === "party" || feierabend || flag("lively");
  // the party demo runs the waiting thresholds 10x faster and starts at lunch time
  if (party) {
    chars.timeScale = 10;
    chars.chatChance = 0.8;
    chars.dwell = 0.4;
  }
  // Friday after work: the shop sells more, so the smokers' corner fills up quickly
  if (feierabend) chars.shopChance = 0.4;
  const cat = new OfficeCat(
    scene.objects,
    scene.fx,
    scene.map,
    () => chars.idleSpots(),
    effects,
    () => chars.catWaitSpots(),
  );
  chars.catEats = (sprite, x, y) => cat.tryEat(sprite, x, y);
  const queen = new OfficeQueen(
    scene.objects,
    scene.map,
    effects,
    () => chars.pageable(),
    (id, text) => chars.answerPage(id, text),
  );
  if (party) {
    cat.eatChance = 0.6;
    cat.eatRange = 900;
    queen.pageEvery = 12;
  }
  const hourValue =
    hourParam !== null ? Number(hourParam) : demo === "party" ? 12.2 : feierabend ? 17.5 : null;
  const living = new Living(scene, model, hourValue);
  const weatherParam = params.get("weather");
  const life = new OfficeLife(
    scene,
    model,
    effects,
    {
      hour: () => living.hour,
      people: () => chars.positions(),
      pongMatch: () => chars.pongMatch(),
      inMeeting: () => chars.inArea("meeting"),
      longWaiters: () => chars.chefWaitSpots(),
      onPizza: () => chars.pizzaArrived(),
      burning: () => chars.burningCount(),
      evacuate: (spot) => chars.evacuate(spot),
      personSpot: (personId) => chars.personSpot(personId),
      catBoss: (spot) => cat.setBoss(spot),
    },
    {
      weather:
        weatherParam === "sun" ||
        weatherParam === "clouds" ||
        weatherParam === "rain" ||
        weatherParam === "snow"
          ? weatherParam
          : null,
      season,
      ...(party ? { droneDelay: demo === "party" ? 6 : 3 } : {}),
      // the feierabend demo is a Friday: happy hour (unless ?event= asks for something else)
      ...(feierabend && !params.get("event") ? { forceEvent: "happyhour" } : {}),
    },
  );
  chars.pizzaActive = () => life.pizzaOnTable;
  chars.hour = () => living.hour;
  chars.lunchSpot = () => life.truckSpot();
  chars.onCoffee = (personId) =>
    life.coffeeDrunk(personId, model.people.get(personId)?.name ?? personId);
  const hud = new Hud(host, model, { kiosk });
  const celebration = new Celebration(host);
  const seenRelease = loadSeen();
  const notes = notesKey(CHANGELOG[0]);
  let celebrate = !demo && !nohud && shouldCelebrate(seenRelease, __BUILD__, notes);
  hud.onWhatsNew = () =>
    celebration.show({
      heading: "What's new",
      version: model.version ? `v${model.version.replace(/^v/, "")}` : null,
      section: CHANGELOG[0],
    });
  // the top bar is 36 px (46 in kiosk) plus the notch inset in an installed app
  const hudTop = host.querySelector<HTMLElement>(".hud-top");
  const fallbackInset = kiosk ? 46 : 36;
  const topInset = nohud ? 0 : () => hudTop?.offsetHeight || fallbackInset;
  const camera = new Camera(
    scene.root,
    () => app.screen,
    () => ({ width: scene.widthPx, height: scene.heightPx }),
    () => scene.map.areas,
    {
      kiosk,
      holdAuto: zoomParam !== null && !kiosk,
      topInset,
      view: params.get("view") === "overview" ? "overview" : "tour",
      overviewEvery: Math.max(20, Number(params.get("every")) || 120),
    },
  );
  camera.attach(app.canvas);
  // wall screens and the fit view frame the office (64 columns); the east street block joins
  // the frame only while someone is there, so tiles stay big on a 1080p wall
  camera.fitWidth = () =>
    chars.positions().some((p) => p.x >= OFFICE_COLS * 16) ? scene.widthPx : OFFICE_COLS * 16;
  camera.skipStop = (name) =>
    (name === "bar" && !scene.barOpen) || (name === "shop" && !scene.shopOpen);
  const minimap = new Minimap(hud.minimapHost, camera, chars);
  minimap.setTerrain(scene.terrainCanvas);
  minimap.desks = () => scene.deskRects();

  // initial view
  if (zoomParam === "fit") camera.zoomToFit(true);
  else if (zoomParam && Number(zoomParam) > 0)
    camera.set({ x: 25 * 16, y: 15 * 16, zoom: Number(zoomParam) }, true);
  else if (app.screen.width / (OFFICE_COLS * 16) > 1.6)
    camera.set({ x: 32 * 16, y: 15 * 16, zoom: 2 }, true);
  else camera.set({ x: 22 * 16, y: 14 * 16, zoom: 2 }, true);

  // ---- events -----------------------------------------------------------------------------
  const ensureCapacity = () => {
    const need = model.podCount();
    if (need <= scene.map.podRows * POD_COLS) return;
    scene.rebuild(buildOfficeMap(podRowsFor(need)));
    cat.setMap(scene.map);
    queen.setMap(scene.map);
    life.reattach();
    minimap.setTerrain(scene.terrainCanvas);
    chars.syncSlots();
    camera.worldChanged();
  };

  let snapshotSeen = false;
  let games: PartyPanel | null = null;
  let messagesPanel: MessagesPanel | null = null;
  let messagesClient: MessagesClient | null = null;
  const messageModel = new MessageModel(storedMessageRead(), () => Date.now() + model.clockSkew);
  /** runs after every message (e.g. a ?focus= waiting for its person to show up) */
  let afterIngest = () => {};
  const ingest = (msg: ServerToViewer) => {
    if (msg.type === "message.deleted") {
      if (messagesPanel) {
        if (messagesClient) messagesClient.removed(msg.data.messageId);
        else messageModel.remove(msg.data.messageId);
        messagesPanel.refresh();
      }
      return;
    }
    if (msg.type === "message.sent") {
      // Kiosk/nohud never retain or render message content, including live socket events.
      if (messagesPanel) {
        const fresh = !messageModel.rows.some((m) => m.id === msg.data.message.id);
        if (messagesClient) messagesClient.receive(msg.data.message);
        else messageModel.receive(msg.data.message);
        if (fresh) messagesPanel.announce(msg.data.message);
        messagesPanel.refresh();
      }
      return;
    }
    const changes = model.apply(msg);
    partyWorld.setState(model.party);
    games?.refresh();
    messagesPanel?.refresh();
    ensureCapacity();
    for (const ch of changes) {
      chars.handle(ch);
      if (ch.kind === "officeRenamed") hud.setOfficeName(ch.name);
      if (ch.kind === "interaction") react(ch);
    }
    if (msg.type === "office.snapshot") {
      snapshotSeen = true;
      hud.setVersion(model.version, __BUILD__);
      if (!demo) {
        const label = newVersionLabel(seenRelease, model.version);
        if (celebrate) {
          celebrate = false;
          celebration.show({ heading: "New version!", version: label, section: CHANGELOG[0] });
        } else if (label && celebration.open) celebration.setVersion(label);
        saveSeen({ build: __BUILD__, version: model.version ?? seenRelease?.version, notes });
      }
      chars.syncSlots();
    }
    hud.setStats(model.stats());
    if (hud.panelOpen && changes.some((change) => change.kind !== "partyChanged")) hud.refresh();
    living.poke();
    afterIngest();
  };

  if (!kiosk && !nohud) {
    const emptyPage = {
      messages: [] as MessageRecord[],
      head: 0,
      older: null,
      next: 0,
      hasMore: false,
      gap: false,
      retention: { maxAgeMs: MESSAGE_RETENTION_MS, maxRows: MESSAGE_MAX_ROWS, expiresAt: null },
    };
    if (demo) messageModel.page(emptyPage, "initial");
    else
      messagesClient = new MessagesClient(messageModel, {
        key,
        changed: () => messagesPanel?.refresh(),
        authFailed: () => {
          messagesPanel?.clear();
          location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        },
      });
    const demoSend = async (request: SendMessageRequest): Promise<SendMessageResponse> => {
      const selected = request.audience.kind === "selected" ? request.audience.personIds : null;
      const recipients = [...model.people.values()]
        .filter((p) => !selected || selected.includes(p.personId))
        .map(({ personId, name }) => ({ personId, name }));
      const seq = (messageModel.rows.at(-1)?.seq ?? messageModel.cursor) + 1;
      const message: MessageRecord = {
        id: crypto.randomUUID(),
        seq,
        ts: Date.now(),
        text: request.text,
        ...(request.from ? { from: request.from } : {}),
        audience: request.audience.kind,
        recipients,
        notifyDesktop: request.notifyDesktop,
      };
      messageModel.ownedIds.add(message.id);
      messageModel.receive(message);
      messageModel.page({ ...emptyPage, messages: [message], head: seq, next: seq }, "catchup");
      messagesPanel?.refresh();
      return { ok: true, message, queued: 0 };
    };
    messagesPanel = new MessagesPanel(host, model, messageModel, {
      demo: !!demo,
      send: messagesClient ? (request) => messagesClient!.send(request) : demoSend,
      delete: messagesClient
        ? (id) => messagesClient!.delete(id)
        : async (id) => {
            messageModel.remove(id);
            messagesPanel?.refresh();
          },
      sync: () => messagesClient?.sync() ?? Promise.resolve(),
      older: () => messagesClient?.older() ?? Promise.resolve(),
      status: () => messagesClient?.status ?? "",
    });
    messagesPanel.onOpen = () => {
      games?.close();
      if (matchMedia("(max-width: 560px)").matches) hud.suspendPanel();
    };
    hud.onMessages = (personId) => messagesPanel?.compose(personId);
    hud.onLogout = () => {
      messagesClient?.clear();
      messageModel.clear();
      messagesPanel?.clear();
    };
  }

  chars.onMoment = (m) => {
    if (m.kind === "joined") camera.notify(m.x, m.y, { zoom: 3, hold: 10, rush: true });
    else if (m.kind === "arrived") {
      hud.showJoin(m.name, m.personId ? hud.portrait(m.personId) : null);
    } else if (m.kind === "record") {
      hud.showBanner(`${m.name}: ${m.count} agents at once!`, "new personal record", {
        portrait: trophyCanvas(),
      });
    } else if (m.kind === "ended") life.graveyard.add();
    else camera.notify(m.x, m.y);
  };

  const BUBBLE: Record<string, string> = { wave: "HI!", coffee: "COFFEE?", cheer: "WOO!" };
  const VERB: Record<string, string> = {
    wave: "waved at",
    coffee: "wants a coffee with",
    cheer: "cheered on",
    message: "sent a message to",
    paper: "threw a paper ball at",
    tomato: "threw a tomato at",
  };
  /** Play an interaction for everyone watching (it comes back from the server to all viewers). */
  function react(ch: Extract<ModelChange, { kind: "interaction" }>) {
    if (ch.interaction === "pet") {
      cat.meow();
      return;
    }
    const targets = ch.personId ? chars.charactersOf(ch.personId) : [];
    const name = ch.personId ? (model.people.get(ch.personId)?.name ?? ch.personId) : "";
    if (ch.interaction === "paper" || ch.interaction === "tomato") {
      const kind = ch.interaction;
      const c = targets[Math.floor(Math.random() * targets.length)];
      if (c) {
        const side = c.x > scene.widthPx / 2 ? -1 : 1;
        const fx = c.x + side * 110;
        if (kind === "tomato")
          effects.throwTomato(fx, c.y - 60, c.x, c.y - 20, () => chars.tomato(c));
        else
          effects.throwBall(fx, c.y - 60, c.x, c.y - 20, () => {
            effects.puff(c.x, c.y - 20);
            chars.say(c, "OUCH!");
          });
        // paper ball war: the third hit within a minute gets thrown back at someone else
        if (ch.personId && chars.hitBy(ch.personId, kind)) {
          const victim = chars.randomOther(ch.personId);
          if (victim)
            effects.after(1.4, () => {
              chars.say(c, "THAT'S IT!");
              effects.throwBall(c.x, c.y - 20, victim.x, victim.y - 20, () => {
                effects.puff(victim.x, victim.y - 20);
                chars.say(victim, "HEY!");
              });
            });
        }
      }
    } else {
      const text =
        ch.interaction === "message"
          ? fitText((ch.text ?? "").toUpperCase(), 110)
          : BUBBLE[ch.interaction]!;
      for (const c of targets) chars.say(c, text);
      if (ch.interaction === "cheer" && targets[0])
        effects.confetti(targets[0].x, targets[0].y - 24, 30);
    }
    const macs =
      ch.delivered === undefined
        ? ""
        : ch.delivered > 0
          ? `popped up on ${ch.delivered} Mac${ch.delivered === 1 ? "" : "s"}`
          : "their Mac is not listening";
    hud.showBanner(`${ch.from || "Someone"} ${VERB[ch.interaction]} ${name}`, macs);
  }

  async function poke(req: PokeRequest | { kind: "pet" }): Promise<PokeResult> {
    if (demo) {
      ingest({
        v: 1,
        type: "interaction.happened",
        id: `demo-${Date.now()}`,
        ts: Date.now(),
        data: {
          ...req,
          ...(req.kind !== "pet" && req.kind !== "paper" && req.kind !== "tomato"
            ? { delivered: 0 }
            : {}),
        },
      });
      return { ok: true, message: "sent (demo: no Macs here)" };
    }
    try {
      const r = await fetch("/api/interact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      const body = (await r.json().catch(() => ({}))) as { delivered?: number; error?: string };
      if (r.status === 401) void loginIfLoggedOut();
      if (!r.ok) return { ok: false, message: body.error ?? `failed (${r.status})` };
      if (req.kind === "tomato") return { ok: true, message: "splat!" };
      if (req.kind === "paper" || req.kind === "pet") return { ok: true, message: "bonk!" };
      return {
        ok: true,
        message: body.delivered
          ? "sent, it popped up on their Mac"
          : "sent (their Mac is not listening)",
      };
    } catch {
      return { ok: false, message: "could not reach the office" };
    }
  }
  if (!kiosk) hud.onPoke = poke;

  /** Look editor: PUT the picked look (null = back to automatic). */
  async function editLook(personId: string, avatar: AvatarSpec | null) {
    if (demo) {
      if (!avatar) return { ok: false, message: "demo: no automatic looks here" };
      ingest({
        v: 1,
        type: "avatar.updated",
        id: `demo-${Date.now()}`,
        ts: Date.now(),
        data: { personId, avatar },
      });
      return { ok: true, message: "saved (demo)", avatar };
    }
    try {
      const from = localStorage.getItem("agent-office.viewerName")?.trim();
      const r = await fetch(
        `/api/people/${encodeURIComponent(personId)}/avatar${key ? `?key=${encodeURIComponent(key)}` : ""}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ avatar, ...(from ? { from } : {}) }),
        },
      );
      const body = (await r.json().catch(() => ({}))) as Partial<AvatarEditResponse> & {
        error?: string;
      };
      if (r.status === 401) void loginIfLoggedOut();
      if (!r.ok) return { ok: false, message: body.error ?? `failed (${r.status})` };
      return {
        ok: true,
        message: avatar ? "saved, looking sharp!" : "back to the automatic look",
        ...(body.avatar ? { avatar: body.avatar } : {}),
      };
    } catch {
      return { ok: false, message: "could not reach the office" };
    }
  }
  if (!kiosk) hud.onEditLook = editLook;
  /** POST helper for the "This is me" flow (cookie auth, JSON errors -> status line). */
  const postJson = async (
    path: string,
    body: unknown,
  ): Promise<PokeResult & { data?: unknown }> => {
    try {
      const r = await fetch(`${path}${key ? `?key=${encodeURIComponent(key)}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.status === 401) void loginIfLoggedOut();
      return r.ok
        ? { ok: true, message: "", data }
        : { ok: false, message: data.error ?? `failed (${r.status})` };
    } catch {
      return { ok: false, message: "could not reach the office" };
    }
  };
  if (demo) hud.editAnyLook = true;
  else if (!kiosk) {
    hud.onClaim = {
      send: async (personId) => {
        const r = await postJson(`/api/people/${encodeURIComponent(personId)}/claim`, {});
        return r.ok
          ? {
              ok: true,
              message:
                "code sent as a notification on your Mac (needs notifications on for the Agent Office connector). Nothing after 30 s? Send again.",
            }
          : r;
      },
      verify: async (personId, code) => {
        const r = await postJson(`/api/people/${encodeURIComponent(personId)}/claim/verify`, {
          code,
        });
        return r.ok ? { ok: true, message: "that's you!" } : r;
      },
      forget: async () => {
        await fetch("/api/me", { method: "DELETE" }).catch(() => {});
      },
    };
    void fetch("/api/me")
      .then((r) => (r.ok ? (r.json() as Promise<{ personId?: string | null }>) : null))
      .then((me) => {
        hud.me = me?.personId ?? null;
        hud.refresh();
      })
      .catch(() => {});
  }
  hud.previewLook = (avatar, agent) => {
    const look = lookFor(avatar, agent, null);
    // front, side, at the desk (back to the camera: the agent patch)
    const previews = [0, 31, 22].map((f) => {
      const c = lookPreview(look, f, 4);
      c.className = "look-canvas";
      return c;
    });
    if (avatar.vehicle !== "none") {
      const ride = avatarPortrait(avatar, agent);
      ride.className = "look-canvas look-ride";
      ride.setAttribute("aria-label", "Vehicle preview");
      previews.push(ride);
    }
    return previews;
  };
  hud.fetchLookCustom = async (personId) => {
    if (demo) return null;
    try {
      const r = await fetch(
        `/api/people/${encodeURIComponent(personId)}/avatar${key ? `?key=${encodeURIComponent(key)}` : ""}`,
      );
      if (!r.ok) return null;
      return ((await r.json()) as AvatarEditResponse).custom;
    } catch {
      return null;
    }
  };

  /** Agent card + ease the camera to the character (clear of the side panel). */
  const openSession = (sessionId: string) => {
    if (kiosk || !hud.openSession(sessionId)) return false;
    const c = chars.chars.get(sessionId);
    if (c) {
      const zoom = Math.max(camera.zoom, 3);
      const panelW = app.screen.width > 560 ? 330 : 0;
      camera.focus(c.x + panelW / 2 / zoom, c.y - 14, zoom);
    }
    return true;
  };
  hud.onOpenSession = (id) => void openSession(id);
  camera.holdWhile = () =>
    hud.panelOpen || hud.lookEditorOpen || (messagesPanel?.expanded ?? false);
  hud.onPanelChange = () => {
    if (hud.panelOpen && matchMedia("(max-width: 560px)").matches && messagesPanel?.expanded)
      messagesPanel.collapse(false);
    chars.selected = hud.openSessionId;
  };
  hud.fetchDay = async (personId): Promise<PersonDayResponse | null> => {
    if (demo) return null;
    const q = key ? `?key=${encodeURIComponent(key)}` : "";
    const r = await fetch(`/api/people/${encodeURIComponent(personId)}${q}`);
    return r.ok ? ((await r.json()) as PersonDayResponse) : null;
  };

  camera.onTap = (wx, wy) => {
    if (!kiosk && life.hitCar(wx, wy)) {
      location.href = key ? `./stats?key=${encodeURIComponent(key)}` : "./stats";
      return;
    }
    if (cat.hit(wx, wy)) {
      cat.meow();
      if (!demo) void poke({ kind: "pet" });
      return;
    }
    const c = chars.pick(wx, wy);
    if (queen.hit(wx, wy) && (!c || queen.y > c.y)) {
      queen.poke();
      return;
    }
    if (c) {
      openSession(c.sessionId);
      return;
    }
    const plate = scene.pickNameplate(wx, wy);
    if (plate) hud.openPanel(plate);
    else hud.closePanel();
  };
  camera.onDoubleTap = (wx, wy) => {
    const c = chars.pick(wx, wy);
    if (!c) return false;
    camera.focus(c.x, c.y - 12, 4);
    return true;
  };
  hud.portrait = (personId) => {
    const c = [...chars.chars.values()].find((ch) => ch.personId === personId);
    const frame = c?.sheet.frames[0];
    const src = frame?.source.resource as HTMLCanvasElement | undefined;
    if (!frame || !src) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 96;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    const r = CHAR_RES;
    ctx.drawImage(src, frame.frame.x * r, frame.frame.y * r, CHAR_W * r, CHAR_H * r, 0, 0, 64, 96);
    return canvas;
  };

  if (demo) {
    const lookRaw = params.get("look");
    // fixture names (`?look=tracht`) load the fixtures chunk only when asked for
    const fixtures =
      lookRaw && !lookRaw.startsWith("b64:")
        ? (await import("@agent-office/protocol/fixtures")).LOOK_FIXTURES
        : {};
    const lookParam = parseLookParam(lookRaw, fixtures);
    const feed = new DemoFeed(
      {
        mode: demo,
        seed: params.get("seed") ?? "1",
        ...(params.get("people") ? { people: Number(params.get("people")) } : {}),
        ...(params.get("sessions") ? { sessions: Number(params.get("sessions")) } : {}),
        ...(params.get("speed") ? { speed: Number(params.get("speed")) } : {}),
        ...(lookParam ? { look: lookParam } : {}),
      },
      (msg) => {
        // round-trip through the real parser so demo data is schema-checked too
        const r = parseViewerMessage(JSON.stringify(msg));
        if (r.ok) ingest(r.msg);
        else console.error("[demo] invalid message", r.error, msg);
      },
    );
    feed.start();
    if (messagesPanel) {
      const seed: MessageRecord = {
        id: "demo-office-message",
        seq: 1,
        ts: Date.now(),
        from: "Demo",
        text: "Lunch in five! Everyone can read office messages here.",
        audience: "everyone",
        recipients: [],
        notifyDesktop: false,
      };
      messageModel.receive(seed);
      messageModel.cursor = 1;
      messageModel.lastRead = 1;
      messagesPanel.refresh();
    }
  } else {
    let newBuild: string | null = null;
    let lastInput = performance.now();
    for (const ev of ["pointerdown", "pointermove", "keydown", "wheel"] as const)
      window.addEventListener(ev, () => (lastInput = performance.now()), {
        capture: true,
        passive: true,
      });
    const typing = () =>
      document.activeElement?.matches("input, textarea, select, [contenteditable]");
    const reloadWhenIdle = () => {
      if (!newBuild) return;
      const ok = mayAutoReload({
        kiosk,
        hidden: document.visibilityState === "hidden",
        busy: hud.lookEditorOpen || (messagesPanel?.hasDraft ?? false) || !!typing(),
        idleMs: performance.now() - lastInput,
      });
      if (ok) reloadInto(newBuild);
    };
    const checkBuild = watchForNewBuild((served) => {
      newBuild = served;
      hud.setUpdateReady(true);
      reloadWhenIdle();
    });
    setInterval(reloadWhenIdle, 15_000);
    connectViewer({
      key,
      onMessage: ingest,
      onStatus: (s) => {
        hud.setStatus(s);
        if (s === "open") {
          checkBuild();
          void messagesClient?.sync(true);
        } else if (messagesClient) {
          messagesClient.status = "Reconnecting — saved messages remain readable.";
          messagesPanel?.refresh();
        }
      },
    });
  }

  const focusPerson = (personId: string, zoom = 3) => {
    const p = model.people.get(personId);
    if (!p) return false;
    // centre on the person's pod (its desks + chairs), whatever its size
    const n = Math.max(2, scene.slotDesks(p.pod));
    const span = podDeskSpan(p.pod, n);
    const o = podOrigin(p.pod);
    camera.set({ x: span.x + span.w / 2, y: o.y * 16 + 30, zoom }, true);
    return true;
  };
  /** Overview close-ups: someone waiting longest, else the pod with the most busy agents. */
  camera.hotSpot = () => {
    let best: { personId: string; score: number } | null = null;
    for (const p of model.people.values()) {
      let score = 0;
      for (const s of model.sessionsOf(p.personId)) {
        if (s.offline) continue;
        if (s.activity === "waiting") score += 10;
        else if (s.activity !== "idle") score += 3;
        score += s.subagents + ((s.context ?? 0) >= 0.8 ? 5 : 0);
      }
      if (score > 0 && (!best || score > best.score)) best = { personId: p.personId, score };
    }
    const p = best && model.people.get(best.personId);
    if (!p) return null;
    const n = Math.max(2, scene.slotDesks(p.pod));
    const span = podDeskSpan(p.pod, n);
    return { x: span.x + span.w / 2, y: podOrigin(p.pod).y * 16 + 30 };
  };
  const focusParam = params.get("focus");
  games = new PartyPanel(host, model, {
    demo: !!demo,
    key,
    focus: (id) => void focusPerson(id, 4),
    customize: (id) => hud.openLookEditor(id),
    onDemo: (mutation) => {
      const avatar = model.people.get(mutation.personId)?.avatar;
      if (!avatar) return;
      const item =
        mutation.hand === "left"
          ? avatar.leftHand
          : mutation.hand === "right"
            ? avatar.rightHand
            : avatar.rightHand !== "none"
              ? avatar.rightHand
              : avatar.leftHand;
      const event: PartyEvent = {
        id: crypto.randomUUID(),
        personId: mutation.personId,
        action: mutation.action,
        item,
        vehicle: avatar.vehicle,
        at: Date.now(),
        ...(mutation.targetId ? { targetId: mutation.targetId } : {}),
        ...(mutation.action === "race" ? { roll: 1 + Math.floor(Math.random() * 6) } : {}),
      };
      const scores = { ...model.party.scores };
      if (["race", "tag", "high-five"].includes(event.action))
        scores[event.personId] = (scores[event.personId] ?? 0) + (event.roll ?? 1);
      if (event.action === "high-five" && event.targetId)
        scores[event.targetId] = (scores[event.targetId] ?? 0) + 1;
      ingest({
        v: 1,
        type: "party.updated",
        id: event.id,
        ts: event.at,
        data: {
          party: {
            scores,
            events: [...model.party.events.filter((e) => event.at - e.at < 15000), event].slice(
              -32,
            ),
          },
        },
      });
    },
  });
  games.onOpen = () => {
    if (messagesPanel?.expanded) messagesPanel.collapse(false);
    if (matchMedia("(max-width: 560px)").matches) hud.suspendPanel();
  };
  if (messagesPanel?.expanded) messagesPanel.onOpen();
  if (focusParam) {
    // with a live server the snapshot arrives later: focus as soon as the person exists
    const tryFocus = () => {
      if (focusPerson(focusParam, Number(zoomParam) || 3)) afterIngest = () => {};
    };
    afterIngest = tryFocus;
    tryFocus();
  }

  if (kiosk) keepAwake();
  if (recorder) {
    startRecorder(app, scene, model, {
      everyMs: Number(params.get("recordEvery")) || 15 * 60_000,
      key,
    });
  }

  // ---- frame loop ---------------------------------------------------------------------------
  let time = 0;
  let speed = 1;
  let frames = 0;
  let fpsWindowStart = performance.now();
  let fps = 0;
  let updMs = 0;
  let renMs = 0;
  let lastUpd = 0;
  let lastRen = 0;
  const renderer = app.renderer;
  const render = renderer.render.bind(renderer) as (...a: unknown[]) => void;
  (renderer as unknown as { render: (...a: unknown[]) => void }).render = (...a: unknown[]) => {
    const t0 = performance.now();
    render(...a);
    renMs += performance.now() - t0;
  };
  const frame = (deltaMS: number) => {
    const t0 = performance.now();
    const dt = Math.min(0.1, deltaMS / 1000) * speed;
    time += dt;
    scene.update(time, dt);
    chars.update(dt, time);
    partyWorld.update(dt, time);
    cat.update(dt, time);
    queen.update(dt, time);
    life.update(dt, time);
    effects.update(dt);
    living.update(dt);
    camera.update(dt);
    if (!nohud && !kiosk) minimap.update(dt);
    frames++;
    const now = performance.now();
    updMs += now - t0;
    if (now - fpsWindowStart >= 1000) {
      fps = (frames * 1000) / (now - fpsWindowStart);
      lastUpd = updMs / frames;
      lastRen = renMs / frames;
      updMs = 0;
      renMs = 0;
      frames = 0;
      fpsWindowStart = now;
    }
  };
  let frameFailed = false;
  app.ticker.add((ticker) => {
    // Pixi stops requesting frames when a ticker callback throws, which freezes a wall screen
    try {
      frame(ticker.deltaMS);
    } catch (e) {
      if (!frameFailed) console.error("[office] frame update failed", e);
      frameFailed = true;
    }
  });
  window.addEventListener("resize", () => camera.resized());

  const api: OfficeApi = {
    ready: false,
    fps: () => Math.round(fps * 10) / 10,
    frameMs: () => ({
      update: Math.round(lastUpd * 100) / 100,
      render: Math.round(lastRen * 100) / 100,
    }),
    model,
    camera: {
      zoomToFit: () => camera.zoomToFit(true),
      focusArea: (name) => camera.focusArea(name, true),
      lookAt: (x, y, zoom) => camera.set({ x: x * 16, y: y * 16, zoom }, true),
      focusPerson: (personId, zoom) => focusPerson(personId, zoom),
    },
    injectEvent(raw) {
      const r = parseViewerMessage(typeof raw === "string" ? raw : JSON.stringify(raw));
      if (r.ok) ingest(r.msg);
      return r.ok;
    },
    snapshotPng: async () => {
      const blob = await captureSnapshot(app, scene);
      if (!blob) return null;
      return await new Promise<string>((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.readAsDataURL(blob);
      });
    },
    characters: () => chars.chars.size,
    setSpeed: (k) => {
      speed = Math.max(0, k);
    },
    openSession,
  };
  window.__office = api;
  await document.fonts?.ready;
  const markReady = () => {
    if (snapshotSeen || !demo) {
      requestAnimationFrame(() => {
        api.ready = true;
      });
    } else setTimeout(markReady, 50);
  };
  markReady();
}

void boot();
