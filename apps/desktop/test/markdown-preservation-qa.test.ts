// Independent T2 acceptance tests: QA owns this file and fixtures/open-markdown/qa-*.json;
// dev owns markdown-document.test.ts (R19). Only the T1 MarkdownDocument API is exercised.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MarkdownBlockInfo, MarkdownDocument, SerializeResult } from "../src/shared/documents.js";

type Fixture = { name: string; source: string };
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/open-markdown/qa-preservation.json", import.meta.url), "utf8"));
const opaque: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/open-markdown/qa-opaque.json", import.meta.url), "utf8"));

// T1 specifies the returned interface, but not the factory's name. Keep that integration binding here.
// A runtime import lets Vitest collect and run every case while T2's module has yet to be implemented.
async function open(source: string): Promise<MarkdownDocument> {
  const modulePath = "../src/shared/markdown-document.js";
  const model = await import(modulePath) as { createMarkdownDocument: (source: string) => MarkdownDocument };
  expect(model.createMarkdownDocument, "T2 factory binding: createMarkdownDocument(source)").toBeTypeOf("function");
  return model.createMarkdownDocument(source);
}

function text(doc: MarkdownDocument): string {
  const result = doc.serialize();
  expect(result, "a basic supported edit must be safe to save").toMatchObject({ ok: true });
  if (!result.ok) throw new Error(JSON.stringify(result.blocks));
  return result.text;
}

function refused(result: SerializeResult, code?: string): void {
  expect(result).toMatchObject({ ok: false });
  expect(result).not.toHaveProperty("text");
  if (result.ok) throw new Error("An unsafe conversion must never expose text to write");
  expect(result.blocks.length).toBeGreaterThan(0);
  for (const reason of result.blocks) {
    expect(reason.message.trim().length).toBeGreaterThan(0);
    expect(["unsupported-construct", "roundtrip-mismatch", "unwritable-text"]).toContain(reason.code);
    if (reason.line !== null) expect(Number.isInteger(reason.line) && reason.line >= 1).toBe(true);
  }
  if (code) expect(result.blocks.some((reason) => reason.code === code)).toBe(true);
}

function blockWith(doc: MarkdownDocument, marker: string): MarkdownBlockInfo {
  const matches = doc.blocks.filter((block) => doc.blockSource(block.id).includes(marker));
  expect(matches, `exactly one source block contains ${marker}`).toHaveLength(1);
  return matches[0]!;
}

describe("T2 QA · AC5: unedited source is the truth", () => {
  it.each(fixtures)("preserves every UTF-8 byte: $name", async ({ source }) => {
    const doc = await open(source);
    expect(doc.source).toBe(source);
    expect(doc.edited).toBe(false);
    expect(doc.blocks.every((block) => !block.edited)).toBe(true);
    const saved = text(doc);
    expect(saved).toBe(source);
    expect(Buffer.from(saved, "utf8")).toEqual(Buffer.from(source, "utf8"));
    expect(text(doc)).toBe(source); // serialization is repeatable and does not itself create an edit
  });

  it("reports nonoverlapping UTF-16 source spans, including after astral Unicode", async () => {
    const source = "\ufeff# 😀 Heading\r\n\r\nTiếng Việt e\u0301 and **đậm**.\r\n\r\n- one\r\n- two\r\n\r\n```ts\r\nconst x = 1;\r\n```";
    const doc = await open(source);
    let previousEnd = 0;
    const ids = new Set<string>();
    for (const block of doc.blocks) {
      expect(ids.has(block.id)).toBe(false);
      ids.add(block.id);
      expect(block.span).not.toBeNull();
      const { start, end } = block.span!;
      expect(Number.isInteger(start) && Number.isInteger(end)).toBe(true);
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(source.length);
      expect(doc.blockSource(block.id)).toBe(source.slice(start, end));
      previousEnd = end;
    }
    for (const marker of ["Heading", "Tiếng", "one", "const x"]) expect(blockWith(doc, marker).editable).toBe(true);
  });
});

const supportedEdits = [
  ["paragraph and escaped punctuation", "Plain ORIGINAL with \\*literal\\* and \\[brackets\\].", "ORIGINAL", "Tiếng Việt 😀", "paragraph"],
  ["ATX heading", "### ORIGINAL heading ###", "ORIGINAL", "Changed **bold**", "heading"],
  ["setext heading", "ORIGINAL heading\n================", "ORIGINAL", "Changed", "heading"],
  ["bold", "An **ORIGINAL** word.", "ORIGINAL", "changed", "paragraph"],
  ["underscore bold", "An __ORIGINAL__ word.", "ORIGINAL", "changed", "paragraph"],
  ["italic", "An *ORIGINAL* word.", "ORIGINAL", "changed", "paragraph"],
  ["underscore italic", "An _ORIGINAL_ word.", "ORIGINAL", "changed", "paragraph"],
  ["nested bold and italic", "A **bold *ORIGINAL* inside** phrase.", "ORIGINAL", "nested", "paragraph"],
  ["link label preserving destination/title", '[ORIGINAL](<folder/my file.md> "keep title")', "ORIGINAL", "Changed **label**", "paragraph"],
  ["link destination with balanced parentheses", '[label](docs/ORIGINAL(v2).md "title")', "ORIGINAL", "changed", "paragraph"],
  ["single-quoted link title", "[label](docs/plan.md 'ORIGINAL')", "ORIGINAL", "changed title", "paragraph"],
  ["escaped link title", '[label](docs/plan.md "ORIGINAL \\"quoted\\" title")', "ORIGINAL", "changed", "paragraph"],
  ["unordered list", "* ORIGINAL\n* **two**\n* three", "ORIGINAL", "changed *item*", "list"],
  ["ordered list", "7) ORIGINAL\n8) **two**\n9) three", "ORIGINAL", "changed", "list"],
  ["nested list", "- outer\n  - **ORIGINAL**\n  - sibling\n- tail", "ORIGINAL", "nested *changed*", "list"],
  ["loose list", "- ORIGINAL\n\n- second paragraph\n\n  continuation", "ORIGINAL", "changed", "list"],
  ["backtick fenced code", "```typescript\nconst ORIGINAL = '`';\n```", "ORIGINAL", "changed", "code"],
  ["fence containing shorter backticks", "````md\nORIGINAL\n```js\nconst x = 1;\n```\n````", "ORIGINAL", "changed", "code"],
  ["tilde fence", "~~~text\nORIGINAL ``` and ~ inside\n~~~", "ORIGINAL", "changed", "code"],
] as const;

describe("T2 QA · AC2/AC4/AC5: supported content stays editable and local", () => {
  it.each(supportedEdits)("edits %s and no surrounding bytes", async (_name, markdown, before, after, kind) => {
    const source = `# Untouched heading  \n\n${markdown}\n\nUntouched tail \\*literal\\*.\n`;
    const doc = await open(source);
    const block = blockWith(doc, before);
    expect(block.kind).toBe(kind);
    expect(block.editable, "basic AC2 constructs cannot be downgraded to view-only").toBe(true);
    expect(block.construct).toBeNull();
    const changed = doc.replace(block.id, doc.blockSource(block.id).replace(before, after));
    const expected = source.replace(before, after);
    expect(text(changed)).toBe(expected);
    expect(changed.source).toBe(source);
    const reopened = await open(text(changed));
    expect(text(reopened)).toBe(expected);
    expect(blockWith(reopened, after).kind).toBe(kind);
    expect(blockWith(reopened, after).editable).toBe(true);
    expect(reopened.edited).toBe(false);
  });

  it.each([
    ["plain to formatted", "Plain ORIGINAL.", "**bold** and *italic* and [link](<a b.md> 'title')."],
    ["heading level", "## ORIGINAL", "#### Changed heading"],
    ["list style", "- ORIGINAL\n- two", "1. changed\n2. **second**"],
    ["format removal", "**ORIGINAL** and *italic*.", "Plain changed and italic."],
    ["code fence delimiter", "```md\nORIGINAL\n```", "````md\ninside ``` ticks\n```\n````"],
    ["new literal escapes", "ORIGINAL", "\\*literal\\* \\[not a link\\] \\# text &amp; e\u0301 😀"],
  ])("supports changing formatting: %s", async (_name, initial, replacement) => {
    const doc = await open(initial);
    const block = blockWith(doc, "ORIGINAL");
    expect(block.editable).toBe(true);
    const changed = doc.replace(block.id, replacement);
    expect(text(changed)).toBe(replacement);
    const reopened = await open(text(changed));
    expect(text(reopened)).toBe(replacement);
    expect(reopened.blocks.every((b) => b.editable)).toBe(true);
  });
});

describe("T2 QA · AC3: immutable unsaved edits", () => {
  it("keeps the original and independent editing branches unchanged", async () => {
    const source = "# First\n\nEditable ORIGINAL.\n\nTail untouched.\n";
    const doc = await open(source);
    const block = blockWith(doc, "ORIGINAL");
    const originalBlocks = JSON.stringify(doc.blocks);
    const first = doc.replace(block.id, doc.blockSource(block.id).replace("ORIGINAL", "first"));
    const second = doc.replace(block.id, doc.blockSource(block.id).replace("ORIGINAL", "second"));
    expect(first).not.toBe(doc);
    expect(first.edited).toBe(true);
    expect(second.edited).toBe(true);
    expect(blockWith(first, "first").edited).toBe(true);
    expect(JSON.stringify(doc.blocks)).toBe(originalBlocks);
    expect(doc.edited).toBe(false);
    expect(text(doc)).toBe(source);
    expect(text(first)).toBe(source.replace("ORIGINAL", "first"));
    expect(text(second)).toBe(source.replace("ORIGINAL", "second"));
    for (const untouched of doc.blocks.filter((b) => b.id !== block.id)) {
      expect(first.blocks.find((b) => b.id === untouched.id)).toEqual(untouched);
    }
  });

  it("composes edits at original spans even when the first edit changes length", async () => {
    const source = "# ORIGINAL heading\n\nMiddle untouched.\n\nLast TARGET.\n";
    const doc = await open(source);
    const head = blockWith(doc, "ORIGINAL");
    const tail = blockWith(doc, "TARGET");
    const changed = doc.replace(head.id, doc.blockSource(head.id).replace("ORIGINAL", "Much longer edited"));
    const both = changed.replace(tail.id, changed.blockSource(tail.id).replace("TARGET", "done"));
    expect(text(both)).toBe(source.replace("ORIGINAL", "Much longer edited").replace("TARGET", "done"));
    expect(text(changed)).toBe(source.replace("ORIGINAL", "Much longer edited"));
  });

  it("removes only the named block when replaced with empty Markdown", async () => {
    const source = "# Keep\n\nRemove ORIGINAL.\n\nTail.\n";
    const doc = await open(source);
    const block = blockWith(doc, "ORIGINAL");
    const { start, end } = block.span!;
    expect(text(doc.replace(block.id, ""))).toBe(source.slice(0, start) + source.slice(end));
    expect(text(doc)).toBe(source);
  });

  it("inserts a new block without rewriting old blocks", async () => {
    const source = "# First\n\nTail **unchanged**.\n";
    const doc = await open(source);
    const head = blockWith(doc, "First");
    const added = doc.insert(head.id, "\n\n## Inserted\n\n");
    expect(added.edited).toBe(true);
    const saved = text(added);
    expect(saved.slice(0, head.span!.end)).toBe(source.slice(0, head.span!.end));
    expect(saved.endsWith(source.slice(head.span!.end))).toBe(true);
    expect(saved).toContain("## Inserted");
    expect(blockWith(added, "Inserted").span).toBeNull();
    expect(blockWith(added, "Inserted").edited).toBe(true);
    expect(text(doc)).toBe(source);
  });

  it("can insert into an empty document", async () => {
    const doc = await open("");
    const added = doc.insert(null, "# New\n\n**content**");
    expect(text(added)).toBe("# New\n\n**content**");
    expect(text(doc)).toBe("");
    expect(added.edited).toBe(true);
  });

  it("can replace one block with several supported blocks", async () => {
    const source = "# Keep\n\nORIGINAL\n\nTail untouched.\n";
    const replacement = "## Added heading\n\n- list item\n- second item\n\n```js\nconst code = 1;\n```";
    const doc = await open(source);
    const block = blockWith(doc, "ORIGINAL");
    const changed = doc.replace(block.id, doc.blockSource(block.id).replace("ORIGINAL", replacement));
    const saved = text(changed);
    expect(saved).toBe(source.replace("ORIGINAL", replacement));
    const reopened = await open(saved);
    expect(blockWith(reopened, "Added heading")).toMatchObject({ kind: "heading", editable: true });
    expect(blockWith(reopened, "list item")).toMatchObject({ kind: "list", editable: true });
    expect(blockWith(reopened, "const code")).toMatchObject({ kind: "code", editable: true });
  });
});

describe("T2 QA · AC5: newline, BOM and Unicode boundaries", () => {
  it.each([
    ["LF with final newline", "", "\n", "\n"],
    ["LF without final newline", "", "\n", ""],
    ["CRLF with final newline", "", "\r\n", "\r\n"],
    ["CRLF without final newline", "", "\r\n", ""],
    ["BOM and CRLF", "\ufeff", "\r\n", "\r\n"],
    ["BOM and no final newline", "\ufeff", "\n", ""],
  ])("keeps file conventions after a local edit: %s", async (_name, bom, eol, final) => {
    const source = `${bom}# Keep${eol}${eol}ORIGINAL e\u0301 😀${eol}${eol}Tail${final}`;
    const doc = await open(source);
    const block = blockWith(doc, "ORIGINAL");
    // Input from contenteditable uses LF even when the file is CRLF.
    const replacement = doc.blockSource(block.id).replace("ORIGINAL", "first\nsecond").replace(/\r\n/g, "\n");
    const changed = doc.replace(block.id, replacement);
    expect(text(changed)).toBe(source.replace("ORIGINAL", `first${eol}second`));
  });

  it("keeps mixed line endings outside the changed source span", async () => {
    const source = "# Keep\r\n\r\nORIGINAL\r\n\r\nTail with LF\n\nLast without newline";
    const doc = await open(source);
    const block = blockWith(doc, "ORIGINAL");
    expect(text(doc.replace(block.id, doc.blockSource(block.id).replace("ORIGINAL", "changed"))))
      .toBe(source.replace("ORIGINAL", "changed"));
  });

  it("inserts at the beginning after the BOM and follows the file's CRLF convention", async () => {
    const source = "\ufeff# Original\r\n\r\nTail without final newline";
    const doc = await open(source);
    expect(text(doc.insert(null, "# Inserted\n\n")))
      .toBe(`\ufeff# Inserted\r\n\r\n${source.slice(1)}`);
    expect(text(doc)).toBe(source);
  });
});

describe("T2 QA · AC5: opaque syntax is preserved or explicitly refused", () => {
  it.each(opaque)("does not normalize unsupported source: $name", async ({ source }) => {
    const doc = await open(source);
    const result = doc.serialize();
    if (result.ok) expect(Buffer.from(result.text)).toEqual(Buffer.from(source));
    else {
      refused(result);
      expect(doc.notices.length).toBeGreaterThan(0);
    }
    for (const block of doc.blocks.filter((b) => !b.editable)) {
      expect(block.construct?.trim().length).toBeGreaterThan(0);
      expect(doc.notices.some((notice) => notice.message.trim().length > 0 && notice.construct === block.construct)).toBe(true);
    }
  });

  it.each(opaque)("a neighbouring edit cannot destroy $name", async ({ source: preserved }) => {
    // Frontmatter must remain at the start. Unclosed fences/HTML may own the tail: refusing is safe there.
    const source = `${preserved}\n\nEditable ORIGINAL.\n\nUnchanged tail.\n`;
    const doc = await open(source);
    const target = blockWith(doc, "ORIGINAL");
    const changed = doc.replace(target.id, doc.blockSource(target.id).replace("ORIGINAL", "changed"));
    const result = changed.serialize();
    if (result.ok) expect(result.text).toBe(source.replace("ORIGINAL", "changed"));
    else refused(result);
    expect(changed.blockSource(blockWith(changed, "changed").id)).toContain("changed");
    expect(doc.source).toBe(source);
  });

  it("refuses edits to any view-only block and supplies a construct and source line", async () => {
    const source = "# Keep\n\n<div>\nraw HTML body\n</div>\n\n[^note]: Footnote text\n";
    const doc = await open(source);
    const immutable = doc.blocks.filter((block) => !block.editable);
    // If a construct becomes fully supported later, preservation tests above remain its AC5 checks.
    for (const block of immutable) {
      const changed = doc.replace(block.id, "replacement");
      const result = changed.serialize();
      refused(result, "unsupported-construct");
      if (!result.ok) expect(result.blocks.some((r) => r.construct === block.construct && r.line !== null)).toBe(true);
      const original = doc.serialize();
      if (original.ok) expect(original.text).toBe(source);
      else refused(original);
    }
  });
});

describe("T2 QA · AC5: failed validation never exposes text to save", () => {
  it.each(["before\u0000after", "before\ud800after", "before\udc00after"])("refuses unwritable edits and retains the draft: %j", async (invalid) => {
    const source = "# Keep\n\nORIGINAL.\n";
    const doc = await open(source);
    const block = blockWith(doc, "ORIGINAL");
    const draft = doc.blockSource(block.id).replace("ORIGINAL", invalid);
    const changed = doc.replace(block.id, draft);
    refused(changed.serialize(), "unwritable-text");
    refused(changed.serialize(), "unwritable-text");
    expect(changed.edited).toBe(true);
    const changedBlock = blockWith(changed, invalid);
    expect(changed.blockSource(changedBlock.id)).toBe(draft);
    expect(text(doc)).toBe(source);
    // A rejected attempt is recoverable, rather than permanently poisoning the document.
    expect(text(changed.replace(changedBlock.id, doc.blockSource(block.id).replace("ORIGINAL", "recovered"))))
      .toBe(source.replace("ORIGINAL", "recovered"));
  });

  it.each(["\u0000", "\ud800", "\udc00"])("refuses unwritable inserted content: %j", async (invalid) => {
    const doc = await open("# Keep\n");
    refused(doc.insert(null, invalid).serialize(), "unwritable-text");
    expect(text(doc)).toBe("# Keep\n");
  });
});
