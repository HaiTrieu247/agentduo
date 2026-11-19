// QA owns this file; dev owns markdown-document.test.ts (R19).
// Acceptance tests for the editor-facing tree API discovered after T2 integration.
import { describe, expect, it } from "vitest";
import { parseMarkdownDocument, type EditableMarkdownDocument, type MdBlock, type MdInline } from "../src/shared/markdown-document.js";

function saved(doc: EditableMarkdownDocument): string {
  const result = doc.serialize();
  expect(result, "an AC2 edit must serialize without loss").toMatchObject({ ok: true });
  if (!result.ok) throw new Error(JSON.stringify(result.blocks));
  return result.text;
}

const blockId = (doc: EditableMarkdownDocument, marker: string): string => {
  const block = doc.blocks.find((b) => doc.blockSource(b.id).includes(marker));
  if (!block) throw new Error(`No block contains ${marker}`);
  return block.id;
};

function plain(nodes: MdInline[]): string {
  return nodes.map((n) => {
    if (n.type === "text" || n.type === "code") return n.value;
    if (n.type === "softbreak" || n.type === "break") return "\n";
    if (n.type === "raw") throw new Error(`Literal text became ${n.construct}`);
    throw new Error(`Literal text acquired ${n.type} formatting`);
  }).join("");
}

describe("T2 QA tree · AC2/AC5: literal edits are escaped", () => {
  it.each([
    "# literal heading", "- literal list", "1. literal ordered list", "> literal quote", "---", "```text",
    "*literal* **literal** _literal_ __literal__", "[label](docs/a.md)", "![image](a.png)",
    "<script>alert(1)</script>", "&amp; &#35; &copy;", "\\*text\\* and `ticks`", "Tiếng Việt 😀 e\u0301",
    "first\n# literal heading\n- literal list",
  ])("keeps newly entered text literal: %j", (value) => {
    const doc = parseMarkdownDocument("# Keep\n\nORIGINAL\n\nTail unchanged.\n");
    const next = doc.replaceNodes(blockId(doc, "ORIGINAL"), [{ type: "paragraph", inlines: [{ type: "text", value }] }]);
    const out = saved(next);
    expect(out.startsWith("# Keep\n\n")).toBe(true);
    expect(out.endsWith("\n\nTail unchanged.\n")).toBe(true);
    const reopened = parseMarkdownDocument(out);
    expect(reopened.blocks).toHaveLength(3);
    const middle = reopened.structure(reopened.blocks[1]!.id)[0]!;
    expect(middle.type).toBe("paragraph");
    if (middle.type !== "paragraph") throw new Error("New text became a different block");
    expect(plain(middle.inlines)).toBe(value);
    expect(doc.edited).toBe(false);
    expect(next.edited).toBe(true);
  });

  it("writes bold, italic, links and inline code as the structure the editor supplied", () => {
    const doc = parseMarkdownDocument("ORIGINAL");
    const next = doc.replaceNodes("b1", [{ type: "paragraph", inlines: [
      { type: "strong", children: [{ type: "text", value: "bold" }] }, { type: "text", value: " and " },
      { type: "emphasis", children: [{ type: "text", value: "italic" }] }, { type: "text", value: " " },
      { type: "link", children: [{ type: "text", value: "label" }], destination: "docs/a b(1).md", title: 'Title "quoted"' },
      { type: "text", value: " " }, { type: "code", value: "`literal`" },
    ] }]);
    const reopened = parseMarkdownDocument(saved(next));
    const paragraph = reopened.structure("b1")[0]!;
    expect(paragraph).toMatchObject({ type: "paragraph", inlines: [
      { type: "strong", children: [{ type: "text", value: "bold" }] }, { type: "text", value: " and " },
      { type: "emphasis", children: [{ type: "text", value: "italic" }] }, { type: "text", value: " " },
      { type: "link", children: [{ type: "text", value: "label" }], destination: "docs/a b(1).md", title: 'Title "quoted"' },
      { type: "text", value: " " }, { type: "code", value: "`literal`" },
    ] });
  });
});

describe("T2 QA tree · AC2/AC5: code and links choose safe delimiters", () => {
  it.each([
    ["text", "before\n```\nafter"], ["md", "``````\ninside\n```"], ["lang`tick", "~~~\nbody\n~~~~"],
    ["ts", "const x = '😀';\n"], ["text", "first\n\n"],
  ])("roundtrips fenced code info %j and value %j", (info, value) => {
    const doc = parseMarkdownDocument("```text\nORIGINAL\n```\n\nTail\n");
    const next = doc.replaceNodes("b1", [{ type: "code", value, info, fence: "```" }]);
    const out = saved(next);
    expect(out.endsWith("\n\nTail\n")).toBe(true);
    const reopened = parseMarkdownDocument(out);
    expect(reopened.structure("b1")[0]).toMatchObject({ type: "code", value, info });
  });

  it.each([
    ["docs/a b.md", 'title with "quotes" and \\ backslash'],
    ["docs/a(b).md", "single ' quote &amp;"],
    ["docs/Việt😀.md", "Tiếng Việt e\u0301"],
  ])("roundtrips link destination %j and title %j", (destination, title) => {
    const doc = parseMarkdownDocument("ORIGINAL");
    const next = doc.replaceNodes("b1", [{ type: "paragraph", inlines: [
      { type: "link", destination, title, children: [{ type: "text", value: "[literal label]" }] },
    ] }]);
    const reopened = parseMarkdownDocument(saved(next));
    expect(reopened.structure("b1")[0]).toMatchObject({ type: "paragraph", inlines: [
      { type: "link", destination, title, children: [{ type: "text", value: "[literal label]" }] },
    ] });
  });
});

describe("T2 QA tree · AC5: untouched regions survive editor operations", () => {
  it.each([
    "Prefix **bold *ORIGINAL* kept** end &amp;.\n",
    "- parent\n  - **ORIGINAL**\n  - sibling\n- tail\n",
  ])("changes nested content while retaining untouched Markdown: %j", (source) => {
    const doc = parseMarkdownDocument(source);
    const id = blockId(doc, "ORIGINAL");
    const nodes = doc.structure(id);
    // These are the editor's detached nodes; retain their source strings while changing one visible value.
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (value === null || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.type === "text" && typeof node.value === "string") node.value = node.value.replace("ORIGINAL", "CHANGED");
      for (const key of ["inlines", "children", "items"]) if (node[key]) visit(node[key]);
    };
    visit(nodes);
    expect(saved(doc.replaceNodes(id, nodes))).toBe(source.replace("ORIGINAL", "CHANGED"));
    expect(saved(doc)).toBe(source);
  });

  it("changes one text node and preserves its escaped siblings and raw inline source", () => {
    const source = "# Keep\n\nORIGINAL \\*literal\\* &amp; ![alt](<a b.png> 'title') __unchanged__.\n\nTail\n";
    const doc = parseMarkdownDocument(source);
    const id = blockId(doc, "ORIGINAL");
    const paragraph = doc.structure(id)[0]!;
    if (paragraph.type !== "paragraph") throw new Error("Fixture must contain a paragraph");
    const first = paragraph.inlines[0]!;
    if (first.type !== "text") throw new Error("Fixture must start with text");
    const next = doc.replaceNodes(id, [{ ...paragraph, inlines: [{ ...first, value: first.value.replace("ORIGINAL", "CHANGED") }, ...paragraph.inlines.slice(1)] }]);
    expect(saved(next)).toBe(source.replace("ORIGINAL", "CHANGED"));
    expect(saved(doc)).toBe(source);
  });

  it.each(["\n", "\r\n", "\r"])("keeps a long reference definition immutable with EOL %j", (eol) => {
    const definition = ['[ref]: /target "first', ...Array.from({ length: 24 }, (_, i) => `title line ${i}`), 'last"'].join(eol);
    const source = `\ufeff${definition}${eol}${eol}ORIGINAL${eol}`;
    const doc = parseMarkdownDocument(source);
    const immutable = doc.blocks.filter((b) => b.construct === "link reference definition");
    expect(immutable).toHaveLength(1);
    const span = immutable[0]!.span!;
    expect(source.slice(span.start, span.end)).toBe(definition);
    expect(immutable[0]!.editable).toBe(false);
    const next = doc.replaceNodes(blockId(doc, "ORIGINAL"), [{ type: "paragraph", inlines: [{ type: "strong", children: [{ type: "text", value: "CHANGED" }] }] }]);
    expect(saved(next)).toBe(source.replace("ORIGINAL", "**CHANGED**"));
    const refused = doc.replaceNodes(immutable[0]!.id, [{ type: "paragraph", inlines: [{ type: "text", value: "change definition" }] }]).serialize();
    expect(refused).toMatchObject({ ok: false, blocks: [{ code: "unsupported-construct", line: 1 }] });
    expect(refused).not.toHaveProperty("text");
  });

  it.each(["replace", "insert"])("keeps mixed line endings inside an untouched code fence during %s", (operation) => {
    const source = "\ufeff```\r\nfirst\nsecond\rthird\r\n```\r\n\r\nORIGINAL\r\n";
    const doc = parseMarkdownDocument(source);
    const id = blockId(doc, "ORIGINAL");
    const nodes: MdBlock[] = [{ type: "paragraph", inlines: [{ type: "text", value: "CHANGED" }] }];
    const next = operation === "replace" ? doc.replaceNodes(id, nodes) : doc.insertNodes(id, nodes);
    const out = saved(next);
    expect(out.startsWith(source.slice(0, source.indexOf("ORIGINAL")))).toBe(true);
    expect(out).toContain("CHANGED");
    expect(saved(doc)).toBe(source);
  });
});
