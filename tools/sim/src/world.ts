/**
 * The simulator's model: laptops (fake connectors) with their sessions, plus the steps a
 * scenario yields. Pure and deterministic; the runner turns steps into real WebSocket traffic,
 * the dry runner (tests) just applies them on a virtual clock.
 */
import {
  type Activity,
  type AgentKind,
  ConnectorToServer,
  envelope,
  type MessageOf,
  personIdFromName,
  type SessionInfo,
} from "@agent-office/protocol";

export type LaptopDef = {
  clientId: string;
  name: string;
  description?: string;
  /** machine label sent in hello ("laptop", "devbox") */
  machine?: string;
};

export type SessionSpec = {
  key: string;
  agent: AgentKind;
  project?: string;
  activity: Activity;
  subagents: number;
  /** how long ago (ms) the session started, relative to the action time */
  ageMs?: number;
};

export type Action =
  /** a laptop comes online (hello) */
  | { op: "connect"; laptop: LaptopDef }
  /** clean quit: bye + close */
  | { op: "bye"; clientId: string }
  /** laptop drops off the network: socket closes, no bye, no more heartbeats */
  | { op: "drop"; clientId: string }
  /** a dropped laptop comes back (same clientId, same sessions) */
  | { op: "reconnect"; clientId: string }
  | { op: "start"; clientId: string; session: SessionSpec }
  | { op: "end"; clientId: string; key: string }
  | { op: "activity"; clientId: string; key: string; activity: Activity }
  | { op: "subagents"; clientId: string; key: string; count: number };

export type Step =
  | Action
  /** pause for this many simulated ms (divided by --speed in real runs) */
  | { op: "wait"; ms: number }
  /** the scenario reached its stable state (screenshots can be taken) */
  | { op: "settled" };

export type SimSession = {
  key: string;
  agent: AgentKind;
  project?: string;
  activity: Activity;
  subagents: number;
  startedAt: number;
};

export type Laptop = LaptopDef & {
  personId: string;
  online: boolean;
  sessions: Map<string, SimSession>;
};

export class World {
  readonly laptops = new Map<string, Laptop>();

  constructor(readonly now: () => number) {}

  /** Apply an action. Returns false (and changes nothing) when it no longer makes sense. */
  apply(a: Action): boolean {
    if (a.op === "connect") {
      if (this.laptops.has(a.laptop.clientId)) return false;
      this.laptops.set(a.laptop.clientId, {
        ...a.laptop,
        personId: personIdFromName(a.laptop.name),
        online: true,
        sessions: new Map(),
      });
      return true;
    }
    const l = this.laptops.get(a.clientId);
    if (!l) return false;
    switch (a.op) {
      case "bye":
        this.laptops.delete(a.clientId);
        return true;
      case "drop":
        if (!l.online) return false;
        l.online = false;
        return true;
      case "reconnect":
        if (l.online) return false;
        l.online = true;
        return true;
      case "start": {
        if (l.sessions.has(a.session.key)) return false;
        const s: SimSession = {
          key: a.session.key,
          agent: a.session.agent,
          activity: a.session.activity,
          subagents: a.session.subagents,
          startedAt: Math.max(0, this.now() - (a.session.ageMs ?? 0)),
        };
        if (a.session.project) s.project = a.session.project;
        l.sessions.set(s.key, s);
        return true;
      }
      case "end":
        return l.sessions.delete(a.key);
      case "activity": {
        const s = l.sessions.get(a.key);
        if (!s || s.activity === a.activity) return false;
        s.activity = a.activity;
        return true;
      }
      case "subagents": {
        const s = l.sessions.get(a.key);
        if (!s || s.subagents === a.count) return false;
        s.subagents = Math.max(0, a.count);
        return true;
      }
    }
  }

  online(): Laptop[] {
    return [...this.laptops.values()].filter((l) => l.online);
  }

  /** Every (laptop, session) pair, online laptops only. */
  liveSessions(): { laptop: Laptop; session: SimSession }[] {
    const out: { laptop: Laptop; session: SimSession }[] = [];
    for (const laptop of this.online())
      for (const session of laptop.sessions.values()) out.push({ laptop, session });
    return out;
  }

  /** People (by personId) with at least one online laptop, and their session count. */
  expectedPeople(): Map<string, number> {
    const m = new Map<string, number>();
    for (const l of this.online()) m.set(l.personId, (m.get(l.personId) ?? 0) + l.sessions.size);
    return m;
  }

  sessionInfos(clientId: string): SessionInfo[] {
    const l = this.laptops.get(clientId);
    if (!l) return [];
    return [...l.sessions.values()].map((s) => {
      const info: SessionInfo = {
        sessionKey: s.key,
        agent: s.agent,
        activity: s.activity,
        subagents: s.subagents,
        startedAt: s.startedAt,
      };
      if (s.project) info.project = s.project;
      return info;
    });
  }
}

// ---- messages -----------------------------------------------------------------------------

export const SIM_CONNECTOR_VERSION = "0.0.0-sim";

/** Throw if a message we are about to send does not match the protocol schema. */
export function validateOutgoing<M>(msg: M): M {
  const r = ConnectorToServer.safeParse(msg);
  if (!r.success) throw new Error(`sim built an invalid message: ${r.error.message}`);
  return msg;
}

export function helloMessage(
  laptop: LaptopDef,
  password: string,
  ts?: number,
): MessageOf<"connector.hello"> {
  const data: MessageOf<"connector.hello">["data"] = {
    name: laptop.name,
    password,
    clientId: laptop.clientId,
    connectorVersion: SIM_CONNECTOR_VERSION,
    platform: "sim",
  };
  if (laptop.description) data.selfDescription = laptop.description;
  if (laptop.machine) data.machine = laptop.machine;
  return validateOutgoing(envelope("connector.hello", data, ts === undefined ? {} : { ts }));
}

export function snapshotMessage(
  sessions: SessionInfo[],
  ts?: number,
): MessageOf<"presence.snapshot"> {
  return validateOutgoing(
    envelope("presence.snapshot", { sessions }, ts === undefined ? {} : { ts }),
  );
}

export function byeMessage(ts?: number): MessageOf<"connector.bye"> {
  return validateOutgoing(envelope("connector.bye", {}, ts === undefined ? {} : { ts }));
}
