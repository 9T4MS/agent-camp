/** Every protocol fixture the connector consumes (server -> connector) or produces parses. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECTOR_TO_SERVER_TYPES,
  ConnectorToServer,
  parseServerToConnector,
  SERVER_TO_CONNECTOR_TYPES,
} from "@agent-office/protocol";

const DIR = join(import.meta.dir, "..", "..", "..", "packages", "protocol", "fixtures");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const load = (f: string): unknown => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const typeOf = (f: string) => f.replace(/\.json$/, "");

describe("protocol fixtures (connector side)", () => {
  const consumed = files.filter((f) => (SERVER_TO_CONNECTOR_TYPES as string[]).includes(typeOf(f)));
  const produced = files.filter((f) => (CONNECTOR_TO_SERVER_TYPES as string[]).includes(typeOf(f)));

  test("there is a fixture for every server->connector type", () => {
    expect(consumed.map(typeOf).sort()).toEqual([...SERVER_TO_CONNECTOR_TYPES].sort());
  });

  for (const f of consumed) {
    test(`parseServerToConnector(${f})`, () => {
      const r = parseServerToConnector(load(f));
      expect(r.ok).toBe(true);
      // also as a raw string, which is what the socket delivers
      expect(parseServerToConnector(readFileSync(join(DIR, f), "utf8")).ok).toBe(true);
    });
  }

  for (const f of produced) {
    test(`connector-sent shape ${f} validates`, () => {
      expect(ConnectorToServer.safeParse(load(f)).success).toBe(true);
    });
  }

  test("garbage never throws", () => {
    for (const bad of ["", "pong", "{", "null", '{"v":2}', '{"v":1,"type":"nope"}']) {
      expect(parseServerToConnector(bad).ok).toBe(false);
    }
  });
});
