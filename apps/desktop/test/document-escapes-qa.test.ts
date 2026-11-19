// QA owns this file (R19). R28/R29 acceptance checks through chat registration, main open and real saved bytes.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@agentduo/engine/testing/tmp";
import { DocumentService, type FileOps } from "../src/main/documents.js";
import type { DesktopEvent } from "../src/shared/protocol.js";

const P = "0123456789abcdef";
const C = "20261118-120000-tab-abcd1234";
type Links = Extract<DesktopEvent, { type: "documentLinks" }>;
let scratch: ReturnType<typeof tempDir>;
let root: string;
beforeEach(() => {
  scratch = tempDir();
  root = realpathSync.native(scratch.path);
});
afterEach(() => scratch.cleanup());

function file(name: string, text: string): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
function harness(ops: Partial<FileOps> = {}) {
  const events: DesktopEvent[] = [];
  const service = new DocumentService({ ops, post: (e) => events.push(e) });
  return {
    service,
    grant(destination: string, fresh = true): Links {
      const from = events.length;
      service.syncLinks(P, C, 1, [{
        id: "pm-escape-qa", kind: "pm",
        text: `[web](https://example.test) [document](${destination}) [code](main.ts)`,
      }], fresh);
      const result = events.slice(from).find((e): e is Links => e.type === "documentLinks");
      expect(result).toBeDefined();
      expect(result!.links).toHaveLength(1);
      expect(result!.links[0]!.ordinal).toBe(1);
      return result!;
    },
    open(linkId: string) {
      return service.open({ projectId: P, conversationId: C, view: 1, linkId, workspace: root });
    },
  };
}

describe("T3 QA — escape targets through registration and save (AC1, AC4; R28–R29)", () => {
  // These fixtures need POSIX file names with literal backslashes, so both the intended file and a real decoy exist.
  it.skipIf(process.platform === "win32").each([
    "report\\(a(b\\))c.md",
    "report\\(a\\(b\\)\\)c.md",
    "report\\(a(b)\\)c.md",
  ])("opens and saves report(a(b))c.md, preserving the literal-backslash decoy for %s", async (written) => {
    const intended = file("report(a(b))c.md", "INTENDED\r\n");
    const decoy = file(written, "DECOY\r\n");
    const h = harness();
    const mapping = h.grant(written);
    const opened = await h.open(mapping.links[0]!.linkId);
    expect(opened).toMatchObject({ ok: true, document: { location: intended, text: "INTENDED\r\n" } });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(readFileSync(intended, "utf8")).toBe("INTENDED\r\n");
    expect(readFileSync(decoy, "utf8")).toBe("DECOY\r\n");
    expect(await h.service.save(opened.document.documentId, opened.document.revision, "EDITED\r\n", false)).toMatchObject({ ok: true });
    expect(readFileSync(intended, "utf8")).toBe("EDITED\r\n");
    expect(readFileSync(decoy, "utf8")).toBe("DECOY\r\n");
  });

  it.each(["dir\\(part)\\file.md", "report\\(part).md"])("refuses an ambiguous link before consulting any file at %s", async (written) => {
    let filesystemCalls = 0;
    const forbidden = async (): Promise<never> => {
      filesystemCalls++;
      throw new Error("ambiguous links must be refused before filesystem lookup");
    };
    const h = harness({ realpath: forbidden, stat: forbidden, lstat: forbidden, open: forbidden, access: forbidden });
    const mapping = h.grant(written);
    const result = await h.open(mapping.links[0]!.linkId);
    expect(result).toMatchObject({ ok: false, error: { code: "link-invalid" } });
    if (result.ok) throw new Error("unexpected document");
    expect(result.error.message).toContain("<");
    expect(result.error.message).toMatch(/path|slash/i);
    expect(filesystemCalls).toBe(0);
    expect(h.service.ids()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("revokes the ambiguous ID when an explicit link to the same written path replaces it", async () => {
    const written = "dir\\(part)\\file.md";
    const target = file(written, "AS WRITTEN");
    const decoy = file(join("dir(part)", "file.md"), "FOLDER DECOY");
    const h = harness();
    const first = h.grant(written);
    const oldId = first.links[0]!.linkId;
    expect(await h.open(oldId)).toMatchObject({ ok: false, error: { code: "link-invalid" } });
    expect(readFileSync(target, "utf8")).toBe("AS WRITTEN");
    expect(readFileSync(decoy, "utf8")).toBe("FOLDER DECOY");
    // The href text is unchanged; only the explicit angle form removes its ambiguity.
    const next = h.grant(`<${written}>`, false);
    expect(next.revoked).toEqual([oldId]);
    expect(next.links[0]!.linkId).not.toBe(oldId);
    expect(await h.open(oldId)).toMatchObject({ ok: false, error: { code: "link-stale" } });
    const opened = await h.open(next.links[0]!.linkId);
    expect(opened).toMatchObject({ ok: true, document: { location: target, text: "AS WRITTEN" } });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(await h.service.save(opened.document.documentId, opened.document.revision, "EXPLICIT EDIT", false)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("EXPLICIT EDIT");
    expect(readFileSync(decoy, "utf8")).toBe("FOLDER DECOY");
  });
});
