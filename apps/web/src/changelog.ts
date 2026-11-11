import changelogMd from "../../../CHANGELOG.md?raw";
import { parseChangelog } from "./release.ts";

/** CHANGELOG.md at the repo root, bundled into the build. */
export const CHANGELOG = parseChangelog(changelogMd);
