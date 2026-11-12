import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AvatarSpec,
  avatarFromSeed,
  CAT_SLOTS,
  CONNECTOR_TO_SERVER_TYPES,
  coerceAvatar,
  compareVersions,
  envelope,
  InteractRequest,
  MAX_CATS,
  type ParseResult,
  PartyState,
  parseConnectorMessage,
  parseServerToConnector,
  parseViewerMessage,
  personIdFromName,
  SERVER_TO_CONNECTOR_TYPES,
  SERVER_TO_VIEWER_TYPES,
  sessionVariation,
  ulid,
  ulidTime,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const load = (type: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${type}.json`), "utf8"));

const parserFor = (type: string): ((x: unknown) => ParseResult<{ type: string }>) => {
  if ((CONNECTOR_TO_SERVER_TYPES as string[]).includes(type)) return parseConnectorMessage;
  if ((SERVER_TO_CONNECTOR_TYPES as string[]).includes(type)) return parseServerToConnector;
  if ((SERVER_TO_VIEWER_TYPES as string[]).includes(type)) return parseViewerMessage;
  throw new Error(`no parser for ${type}`);
};

const ALL_TYPES = [
  ...CONNECTOR_TO_SERVER_TYPES,
  ...SERVER_TO_CONNECTOR_TYPES,
  ...SERVER_TO_VIEWER_TYPES,
];

describe("fixtures", () => {
  test("there is exactly one fixture per message type", () => {
    const files = readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(files).toEqual([...ALL_TYPES].sort());
  });

  for (const type of ALL_TYPES) {
    test(`${type} parses with its channel parser`, () => {
      const raw = load(type);
      const r = parserFor(type)(raw);
      if (!r.ok) throw new Error(r.error);
      expect(r.msg.type).toBe(type);
      // and also from a raw JSON string
      expect(parserFor(type)(JSON.stringify(raw)).ok).toBe(true);
    });
  }

  test("messages are rejected on the wrong channel", () => {
    expect(parseViewerMessage(load("connector.hello")).ok).toBe(false);
    expect(parseConnectorMessage(load("office.snapshot")).ok).toBe(false);
    expect(parseServerToConnector(load("presence.snapshot")).ok).toBe(false);
  });
});

describe("negative parsing", () => {
  const hello = load("connector.hello") as Record<string, unknown> & {
    data: Record<string, unknown>;
  };
  test("wrong protocol version", () => {
    const r = parseConnectorMessage({ ...hello, v: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("version");
  });
  test("unknown type", () => {
    expect(parseConnectorMessage({ ...hello, type: "connector.dance" }).ok).toBe(false);
  });
  test("missing fields", () => {
    const { password: _pw, ...data } = hello.data;
    expect(parseConnectorMessage({ ...hello, data }).ok).toBe(false);
    const { id: _id, ...noId } = hello;
    expect(parseConnectorMessage(noId).ok).toBe(false);
  });
  test("machine is optional (old connectors) and at most 40 chars", () => {
    const { machine: _m, ...old } = hello.data;
    const r = parseConnectorMessage({ ...hello, data: old });
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "connector.hello") expect(r.msg.data.machine).toBeUndefined();
    expect(parseConnectorMessage({ ...hello, data: { ...old, machine: "x".repeat(41) } }).ok).toBe(
      false,
    );
    const started = load("session.started") as { data: { session: Record<string, unknown> } };
    const { machine: _sm, ...oldSession } = started.data.session;
    expect(
      parseViewerMessage({ ...started, data: { ...started.data, session: oldSession } }).ok,
    ).toBe(true);
  });
  test("garbage never throws", () => {
    for (const g of [null, undefined, 42, "nope", "{", "[]", [], {}, { v: 1 }]) {
      expect(parseConnectorMessage(g).ok).toBe(false);
      expect(parseViewerMessage(g).ok).toBe(false);
      expect(parseServerToConnector(g).ok).toBe(false);
    }
  });
  test("bad session info", () => {
    const snap = load("presence.snapshot") as { data: { sessions: Record<string, unknown>[] } };
    const s0 = snap.data.sessions[0]!;
    const bad = [
      { ...s0, activity: "dancing" },
      { ...s0, subagents: -1 },
      { ...s0, subagents: 1.5 },
      { ...s0, sessionKey: "short" },
      { ...s0, project: "x".repeat(81) },
    ];
    for (const s of bad) {
      expect(parseConnectorMessage({ ...snap, data: { sessions: [s] } }).ok).toBe(false);
    }
  });
  test("an unknown agent kind degrades to unknown instead of failing the message", () => {
    // a newer connector or server may add kinds; older readers must keep the rest
    const snap = load("presence.snapshot") as { data: { sessions: Record<string, unknown>[] } };
    const future = { ...snap.data.sessions[0]!, agent: "some-future-agent" };
    const r = parseConnectorMessage({
      ...snap,
      data: { sessions: [future, ...snap.data.sessions] },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "presence.snapshot") {
      expect(r.msg.data.sessions[0]!.agent).toBe("unknown");
      expect(r.msg.data.sessions.slice(1).map((x): string => x.agent)).toEqual(
        snap.data.sessions.map((x) => x.agent as string),
      );
    }
    const started = load("session.started") as { data: { session: Record<string, unknown> } };
    const v = parseViewerMessage({
      ...started,
      data: { ...started.data, session: { ...started.data.session, agent: "gemini" } },
    });
    expect(v.ok).toBe(true);
    if (v.ok && v.msg.type === "session.started") expect(v.msg.data.session.agent).toBe("unknown");
    const office = load("office.snapshot") as {
      data: { people: { sessions: Record<string, unknown>[] }[] };
    };
    const person = office.data.people.find((p) => p.sessions.length > 0)!;
    const o = parseViewerMessage({
      ...office,
      data: {
        ...office.data,
        people: office.data.people.map((p) =>
          p === person ? { ...p, sessions: p.sessions.map((x) => ({ ...x, agent: "gemini" })) } : p,
        ),
      },
    });
    expect(o.ok).toBe(true);
  });
  test("party state is optional for older snapshots and validates equipment and rolls", () => {
    expect(parseViewerMessage(load("office.snapshot")).ok).toBe(true);
    const message = load("party.updated") as {
      data: { party: { events: Record<string, unknown>[]; scores: Record<string, number> } };
    };
    const event = message.data.party.events[0]!;
    for (const bad of [
      { ...event, roll: 7 },
      { ...event, roll: 0 },
      { ...event, at: -1 },
    ])
      expect(
        parseViewerMessage({
          ...message,
          data: { party: { ...message.data.party, events: [bad] } },
        }).ok,
      ).toBe(false);
    expect(
      parseViewerMessage({ ...message, data: { party: { ...message.data.party, profiles: {} } } })
        .ok,
    ).toBe(true);
  });
  test("future avatar and party equipment IDs do not drop the office snapshot", () => {
    const snapshot = load("office.snapshot") as {
      data: { people: { avatar: Record<string, unknown> }[] };
    };
    const event = {
      id: "future",
      personId: "anna",
      action: "use",
      item: "future-item",
      vehicle: "future-ride",
      at: 1000,
    };
    const party = { events: [event], scores: {} };
    const people = snapshot.data.people.map((person) => ({
      ...person,
      avatar: { ...person.avatar, leftHand: "future-item", vehicle: "future-ride" },
    }));
    const parsed = parseViewerMessage({ ...snapshot, data: { ...snapshot.data, people, party } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.msg.type === "office.snapshot") {
      expect(parsed.msg.data.party?.events[0]).toMatchObject({ item: "none", vehicle: "none" });
      expect(parsed.msg.data.people[0]?.avatar.leftHand).toBe("none");
      expect(parsed.msg.data.people[0]?.avatar.vehicle).toBe("none");
    } else throw new Error("snapshot rejected");
    const update = load("party.updated") as { data: unknown };
    expect(parseViewerMessage({ ...update, data: { party } }).ok).toBe(true);
    expect(PartyState.safeParse(party).success).toBe(false);
  });
  test("future party actions and fields degrade safely without losing office presence", () => {
    const update = load("party.updated") as {
      data: { party: { events: Record<string, unknown>[]; scores: Record<string, number> } };
    };
    const party = {
      ...update.data.party,
      futureState: true,
      events: [{ ...update.data.party.events[0], action: "future-dance", futureEvent: true }],
    };
    const parsed = parseViewerMessage({ ...update, data: { party } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.msg.type === "party.updated") {
      expect(parsed.msg.data.party.events[0]?.action).toBe("wave");
      expect(parsed.msg.data.party).not.toHaveProperty("futureState");
      expect(parsed.msg.data.party.events[0]).not.toHaveProperty("futureEvent");
    } else throw new Error("future party message rejected");
    expect(PartyState.safeParse(party).success).toBe(false);
    const snapshot = load("office.snapshot") as { data: { people: unknown[] } };
    for (const optionalParty of [party, { changedFormat: true }, null, "future-format"]) {
      const result = parseViewerMessage({
        ...snapshot,
        data: { ...snapshot.data, party: optionalParty },
      });
      expect(result.ok).toBe(true);
      if (result.ok && result.msg.type === "office.snapshot") {
        expect(result.msg.data.people.length).toBe(snapshot.data.people.length);
        if (optionalParty !== party) expect(result.msg.data.party).toBeUndefined();
      }
    }
  });
  test("invalid avatar in avatar.updated", () => {
    // unknown ids fall back (see "viewers tolerate catalog ids"), but not a missing avatar
    const m = load("avatar.updated") as { data: { avatar: Record<string, unknown> } };
    for (const avatar of [undefined, null, "afro-unicorn", 42])
      expect(parseViewerMessage({ ...m, data: { ...m.data, avatar } }).ok).toBe(false);
  });
});

describe("cat interactions", () => {
  const ok = (body: unknown) => InteractRequest.safeParse(body).success;
  test("cat kinds need no person, spot kinds need a spot", () => {
    expect(ok({ kind: "pet" })).toBe(true);
    expect(ok({ kind: "pet", catId: 3 })).toBe(true);
    expect(ok({ kind: "feed", catId: 1, x: 640, y: 120 })).toBe(true);
    expect(ok({ kind: "yarn", catId: 0, x: 10, y: 10 })).toBe(true);
    expect(ok({ kind: "laser", x: 700, y: 300 })).toBe(true);
    expect(ok({ kind: "feed", catId: 1 })).toBe(false);
    expect(ok({ kind: "laser", x: 700 })).toBe(false);
  });
  test("sending a cat needs a person", () => {
    expect(ok({ kind: "cat", catId: 2 })).toBe(false);
    expect(ok({ kind: "cat", catId: 2, personId: "anna" })).toBe(true);
  });
  test("cat ids and spots are bounded", () => {
    expect(ok({ kind: "pet", catId: CAT_SLOTS })).toBe(false);
    // the resident cats (Cece and Jess) come right after the colony slots
    expect(ok({ kind: "pet", catId: MAX_CATS })).toBe(true);
    expect(ok({ kind: "feed", catId: CAT_SLOTS - 1, x: 10, y: 10 })).toBe(true);
    expect(ok({ kind: "pet", catId: -1 })).toBe(false);
    expect(ok({ kind: "pet", catId: 1.5 })).toBe(false);
    expect(ok({ kind: "laser", x: -1, y: 10 })).toBe(false);
    expect(ok({ kind: "laser", x: 10, y: 9000 })).toBe(false);
    expect(ok({ kind: "laser", x: 10.5, y: 10 })).toBe(false);
  });
  test("interaction.happened carries the cat and the spot", () => {
    const m = load("interaction.happened") as { data: Record<string, unknown> };
    const yarn = { ...m, data: { kind: "yarn", from: "Martin", catId: 4, x: 600, y: 140 } };
    expect(parseViewerMessage(yarn).ok).toBe(true);
    expect(parseViewerMessage({ ...yarn, data: { ...yarn.data, catId: 99 } }).ok).toBe(false);
  });
  test("a cat poke reaches the connector channel", () => {
    const m = load("connector.poked") as { data: Record<string, unknown> };
    const r = parseServerToConnector({ ...m, data: { kind: "cat", text: "a cat" } });
    expect(r.ok).toBe(true);
  });
});

describe("envelope()", () => {
  test("builds a message that round-trips through the parser", () => {
    const m = envelope("presence.snapshot", {
      sessions: [
        {
          sessionKey: "abcdef0123456789",
          agent: "claude",
          activity: "thinking",
          subagents: 0,
          startedAt: 1,
        },
      ],
    });
    expect(m.v).toBe(1);
    expect(m.id).toHaveLength(26);
    const r = parseConnectorMessage(JSON.stringify(m));
    expect(r.ok).toBe(true);
  });
});

describe("avatars", () => {
  test("avatarFromSeed is deterministic and valid", () => {
    for (let i = 0; i < 300; i++) {
      const seed = `person-${i}`;
      const a = avatarFromSeed(seed);
      expect(avatarFromSeed(seed)).toEqual(a);
      expect(AvatarSpec.safeParse(a).success).toBe(true);
    }
  });
  test("avatarFromSeed varies across seeds", () => {
    const styles = new Set(
      Array.from({ length: 100 }, (_, i) => avatarFromSeed(`p${i}`).hairStyle),
    );
    expect(styles.size).toBeGreaterThan(4);
    expect(avatarFromSeed("anna")).not.toEqual(avatarFromSeed("martin"));
  });
  test("looks from before outfits / held items get the defaults", () => {
    const { outfit: _o, leftHand: _l, rightHand: _r, ...old } = avatarFromSeed("anna");
    const r = AvatarSpec.parse(old);
    expect(r.outfit).toBe("jacket");
    expect(r.leftHand).toBe("none");
    expect(r.rightHand).toBe("none");
  });
  test("seeded looks stay plain: jacket, empty hands, no editor-only cap", () => {
    for (let i = 0; i < 500; i++) {
      const a = avatarFromSeed(`p${i}`);
      expect([a.outfit, a.leftHand, a.rightHand]).toEqual(["jacket", "none", "none"]);
      expect(a.accessory).not.toBe("cap-mint");
    }
  });
  test("viewers tolerate catalog ids from a newer server", () => {
    const raw = load("avatar.updated") as { data: { avatar: Record<string, unknown> } };
    raw.data.avatar = {
      ...raw.data.avatar,
      accessory: "top-hat-from-the-future",
      outfit: "space-suit",
      wrist: "future-cuffs",
      accentColor: "ultraviolet",
      vehicle: "teleporter",
      deskProps: ["plant", "hologram", "plant"],
    };
    const r = parseViewerMessage(raw);
    if (!r.ok) throw new Error(r.error);
    if (r.msg.type !== "avatar.updated") throw new Error("wrong type");
    expect(r.msg.data.avatar.accessory).toBe("none");
    expect(r.msg.data.avatar.outfit).toBe("jacket");
    expect(r.msg.data.avatar.leftHand).toBe("none");
    expect(r.msg.data.avatar.wrist).toBe("none");
    expect(r.msg.data.avatar.accentColor).toBe("cyan");
    expect(r.msg.data.avatar.vehicle).toBe("none");
    expect(r.msg.data.avatar.deskProps).toEqual(["plant"]);
  });
  test("avatar requests keep rejecting unknown wardrobe ids", () => {
    const avatar = avatarFromSeed("anna");
    for (const field of ["wrist", "accentColor", "vehicle"] as const)
      expect(AvatarSpec.safeParse({ ...avatar, [field]: "from-the-future" }).success).toBe(false);
  });
  test("coerceAvatar falls back on garbage", () => {
    expect(coerceAvatar({ hairStyle: "nope" }, "anna")).toEqual(avatarFromSeed("anna"));
    const good = avatarFromSeed("x");
    expect(coerceAvatar(good, "anna")).toEqual(good);
  });
  test("duplicate or too many desk props are invalid", () => {
    const a = avatarFromSeed("anna");
    expect(AvatarSpec.safeParse({ ...a, deskProps: ["mug", "mug"] }).success).toBe(false);
    expect(
      AvatarSpec.safeParse({ ...a, deskProps: ["mug", "plant", "lamp", "books"] }).success,
    ).toBe(false);
  });
  test("sessionVariation is deterministic", () => {
    const v = sessionVariation("abcdef0123456789");
    expect(sessionVariation("abcdef0123456789")).toEqual(v);
    expect([-1, 0, 1]).toContain(v.hairShade);
    const shades = new Set(
      Array.from({ length: 50 }, (_, i) => sessionVariation(`k${i}`).hairShade),
    );
    expect(shades.size).toBe(3);
  });
});

describe("helpers", () => {
  test("compareVersions", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.5", "0.1.5")).toBe(0);
    expect(compareVersions("v0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.3-dev", "0.1.3")).toBe(0);
    expect(compareVersions("garbage", "0.0.0")).toBe(0);
  });
  test("personIdFromName", () => {
    expect(personIdFromName("Anna")).toBe("anna");
    expect(personIdFromName("  Anna Müller ")).toBe("anna-muller");
    expect(personIdFromName("ANNA")).toBe(personIdFromName("anna"));
    expect(personIdFromName("Jean-Luc O'Neil!")).toBe("jean-luc-o-neil");
    const emoji = personIdFromName("🤖🤖");
    expect(emoji).toMatch(/^p-[0-9a-z]+$/);
    expect(personIdFromName("🤖🤖")).toBe(emoji);
    expect(personIdFromName("x".repeat(100)).length).toBeLessThanOrEqual(40);
  });
  test("ulid uniqueness and sortability", () => {
    const ids = Array.from({ length: 5000 }, () => ulid());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids.slice(0, 10)) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid(1000) < ulid(2000)).toBe(true);
    expect(ulidTime(ulid(1793174400000))).toBe(1793174400000);
  });
});
