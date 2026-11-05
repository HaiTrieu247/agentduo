// Every test file's agentduo data root is a folder of its own: a run in a folder with no git repository (or a test
// that forgets userDataEnv) never creates a snapshot repository under the user's real one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { userDataEnv } from "./helpers/config.js";

const dir = mkdtempSync(join(tmpdir(), "agentduo-data-"));
Object.assign(process.env, userDataEnv(dir));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
