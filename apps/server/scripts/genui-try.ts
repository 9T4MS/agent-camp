/**
 * Manual try-out of the GenUI look generation against the real API (not run in CI; costs one
 * model call). Prints the repaired AvatarSpec and a `?look=b64:` link for the web client.
 *
 *   ANTHROPIC_API_KEY=... bun apps/server/scripts/genui-try.ts <description.md|-> [name]
 *   GENUI_PROVIDER=jev AI_GATEWAY_API_KEY=... bun apps/server/scripts/genui-try.ts desc.md
 *
 * Default model claude-haiku-4-5; GENUI_MODEL=claude-opus-5-5 tries the pricier model, and
 * GENUI_EFFORT sets its effort (ignored on Haiku 4.5). Use `-` to read the description from stdin.
 */
import { readFileSync } from "node:fs";
import { MAX_SELF_DESCRIPTION, personIdFromName } from "@agent-office/protocol";
import { createAvatarService } from "../src/core/genui.ts";
import { MemoryStore } from "../src/core/store.ts";

const [file, name = "Try Out"] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun apps/server/scripts/genui-try.ts <description.md|-> [name]");
  process.exit(2);
}
const description = readFileSync(file === "-" ? 0 : file, "utf8").trim();
if (description.length > MAX_SELF_DESCRIPTION)
  console.error(
    `note: description has ${description.length} chars; only the first ${MAX_SELF_DESCRIPTION} are used`,
  );

const env = {
  GENUI_PROVIDER: process.env.GENUI_PROVIDER ?? "anthropic",
  GENUI_MODEL: process.env.GENUI_MODEL,
  GENUI_EFFORT: process.env.GENUI_EFFORT,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  GENUI_MAX_CALLS_PER_DAY: "1",
};
const svc = createAvatarService(env, new MemoryStore(), { log: (l) => console.error(l) });
if (svc.providerId === "off") {
  console.error(
    "no provider configured: set ANTHROPIC_API_KEY (or GENUI_PROVIDER=jev + AI_GATEWAY_API_KEY)",
  );
  process.exit(2);
}

const started = Date.now();
const res = await svc.resolve({
  personId: personIdFromName(name),
  name,
  selfDescription: description.slice(0, MAX_SELF_DESCRIPTION),
});
console.error(`${res.source} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(res.avatar, null, 2));
const b64 = Buffer.from(JSON.stringify(res.avatar)).toString("base64url");
console.error(`\nview: http://localhost:5173/?demo=one&look=b64:${b64}&zoom=6`);
process.exit(res.source === "ai" ? 0 : 1);
