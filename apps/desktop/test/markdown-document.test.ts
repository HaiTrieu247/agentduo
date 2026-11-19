// The Markdown model (shared/markdown-document.ts): unedited it is the source byte for byte; an edit changes only the
// blocks it names; what cannot be written safely is refused with a reason and no text (AC2 to AC5).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  escapeText, normalizeInlines, parseBlocks, parseInlines, parseMarkdownDocument, renderBlocks, renderCodeSpan, renderFence,
  type EditableMarkdownDocument, type MdBlock, type MdInline,
} from "../src/shared/markdown-document.js";

const fixtureDir = join(import.meta.dirname, "fixtures", "open-markdown");
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".md")).sort();
const fixture = (name: string): string => readFileSync(join(fixtureDir, name), "utf8");

/** The source with each variation a real file can have. */
const variants = (src: string): [string, string][] => [
  ["as is", src],
  ["CRLF", src.replace(/\r?\n/g, "\r\n")],
  ["CR", src.replace(/\r?\n/g, "\r")],
  ["BOM", "\ufeff" + src],
  ["BOM and CRLF", "\ufeff" + src.replace(/\r?\n/g, "\r\n")],
  ["no final newline", src.replace(/(\r?\n)+$/, "")],
  ["several final newlines", src.replace(/(\r?\n)+$/, "") + "\n\n\n"],
];

const written = (doc: EditableMarkdownDocument): string => {
  const r = doc.serialize();
  if (!r.ok) throw new Error(`refused: ${r.blocks.map((b) => `${b.code}: ${b.message}`).join("; ")}`);
  return r.text;
};
const refusal = (doc: EditableMarkdownDocument) => {
  const r = doc.serialize();
  if (r.ok) throw new Error(`written: ${JSON.stringify(r.text)}`);
  return r.blocks;
};
const blockOf = (doc: EditableMarkdownDocument, needle: string): string => {
  const b = doc.blocks.find((x) => doc.blockSource(x.id).includes(needle));
  if (!b) throw new Error(`no block with ${needle}`);
  return b.id;
};
/** The source's text outside the blocks `ids` and their spans, as one string, to compare what an edit left alone. */
const outside = (src: string, doc: EditableMarkdownDocument, ids: string[]): string => {
  let out = "";
  let at = 0;
  for (const b of doc.blocks) {
    if (!ids.includes(b.id) || !b.span) continue;
    out += src.slice(at, b.span.start);
    at = b.span.end;
  }
  return out + src.slice(at);
};
const para = (doc: EditableMarkdownDocument, id: string): Extract<MdBlock, { type: "paragraph" }> => {
  const b = doc.structure(id)[0];
  if (b?.type !== "paragraph") throw new Error("not a paragraph");
  return b;
};

describe("unedited, the source comes back byte for byte (guarantee 1)", () => {
  for (const name of fixtures) {
    for (const [label, text] of variants(fixture(name))) {
      it(`${name}, ${label}`, () => {
        const doc = parseMarkdownDocument(text);
        expect(doc.source).toBe(text);
        expect(doc.edited).toBe(false);
        expect(written(doc)).toBe(text);
      });
    }
  }

  it("also when every block is replaced with its own text or rewritten from its own tree", () => {
    for (const name of fixtures) {
      for (const [, text] of variants(fixture(name))) {
        let doc = parseMarkdownDocument(text);
        for (const b of doc.blocks.filter((x) => x.editable)) {
          doc = doc.replace(b.id, doc.blockSource(b.id));
          expect(doc.edited).toBe(false);
          doc = doc.replaceNodes(b.id, doc.structure(b.id));
        }
        expect(written(doc)).toBe(text);
      }
    }
  });

  it("keeps the spans inside the source and in order, and says which blocks the editor cannot edit", () => {
    const text = fixture("constructs.md");
    const doc = parseMarkdownDocument(text);
    let last = 0;
    for (const b of doc.blocks) {
      expect(b.span!.start).toBeGreaterThanOrEqual(last);
      expect(b.span!.end).toBeGreaterThan(b.span!.start);
      last = b.span!.end;
    }
    const by = (c: string) => doc.blocks.find((b) => b.construct === c);
    expect(by("front matter")).toMatchObject({ kind: "other", editable: false });
    expect(by("html block")).toMatchObject({ kind: "other", editable: false });
    expect(by("table")).toMatchObject({ kind: "table", editable: false });
    expect(by("footnote definition")).toMatchObject({ editable: false });
    expect(by("link reference definition")).toMatchObject({ editable: false });
    expect(doc.notices.map((n) => n.construct)).toEqual(expect.arrayContaining(["front matter", "html block", "table", "footnote definition", "link reference definition"]));
    expect(doc.notices.every((n) => n.code === "unsupported-construct" && n.line !== null)).toBe(true);
  });

  it("treats the basic constructs of AC2 as editable, never as unsupported", () => {
    const doc = parseMarkdownDocument(fixture("basic.md"));
    expect(doc.blocks.every((b) => b.editable)).toBe(true);
    expect(doc.notices).toEqual([]);
    expect(new Set(doc.blocks.map((b) => b.kind))).toEqual(new Set(["heading", "paragraph", "list", "code", "quote", "rule"]));
  });

  it("opens an empty file and a file of blank lines without blocks", () => {
    for (const name of ["empty.md", "blank.md"]) {
      const doc = parseMarkdownDocument(fixture(name));
      expect(doc.blocks).toEqual([]);
      expect(written(doc)).toBe(fixture(name));
    }
  });
});

describe("an edit changes the block it names and nothing else (guarantee 2)", () => {
  for (const [label, text] of variants(fixture("basic.md"))) {
    it(`replacing a heading's text, ${label}`, () => {
      const doc = parseMarkdownDocument(text);
      const id = blockOf(doc, "# Mở tài liệu");
      const next = doc.replace(id, "# Đã sửa");
      expect(next.edited).toBe(true);
      expect(next.blocks.find((b) => b.id === id)).toMatchObject({ edited: true });
      expect(next.blocks.filter((b) => b.edited)).toHaveLength(1);
      const out = written(next);
      expect(out).toBe(text.replace("# Mở tài liệu", "# Đã sửa"));
      expect(outside(out, parseMarkdownDocument(out), [blockOf(parseMarkdownDocument(out), "# Đã sửa")])).toBe(outside(text, doc, [id]));
    });
  }

  it("writes the replacement with the line endings of the source", () => {
    const text = "para one\r\n\r\npara two\r\nsecond line\r\n";
    const doc = parseMarkdownDocument(text);
    const out = written(doc.replace("b2", "new\nlines\nhere"));
    expect(out).toBe("para one\r\n\r\nnew\r\nlines\r\nhere\r\n");
  });

  it("follows the line ending of the block itself in a file with both", () => {
    const text = "one\n\ntwo\r\nlines\r\n\r\nthree\n";
    const doc = parseMarkdownDocument(text);
    expect(written(doc.replace("b2", "a\nb"))).toBe("one\n\na\r\nb\r\n\r\nthree\n");
    expect(written(doc.replace("b3", "x\ny"))).toBe("one\n\ntwo\r\nlines\r\n\r\nx\ny\n");
  });

  it("keeps the BOM, the blank lines and the missing final newline", () => {
    const text = "\ufeff\n\n# T\n\n\n\nbody";
    const doc = parseMarkdownDocument(text);
    expect(written(doc.replace("b2", "body 2"))).toBe("\ufeff\n\n# T\n\n\n\nbody 2");
    expect(written(doc.replace("b1", "# U"))).toBe("\ufeff\n\n# U\n\n\n\nbody");
  });

  it("keeps front matter, HTML, a table and definitions byte for byte around an edited block", () => {
    const text = fixture("constructs.md");
    const doc = parseMarkdownDocument(text);
    const id = blockOf(doc, "Đoạn cuối");
    const out = written(doc.replace(id, "Đoạn cuối đã đổi."));
    expect(out).toBe(text.replace(/Đoạn cuối với[^\n]*/, "Đoạn cuối đã đổi."));
  });

  it("an edit that changes nothing is not an edit", () => {
    const doc = parseMarkdownDocument(fixture("basic.md"));
    const next = doc.replace("b2", doc.blockSource("b2"));
    expect(next.edited).toBe(false);
    const changed = doc.replace("b2", "X");
    expect(changed.edited).toBe(true);
    expect(changed.replace("b2", doc.blockSource("b2")).edited).toBe(false);
  });

  it("removes exactly the block's own text: the blank lines and newlines around it stay (nothing is cleaned up)", () => {
    expect(written(parseMarkdownDocument("a\n\nb\n\nc\n").replace("b2", ""))).toBe("a\n\n\n\nc\n");
    expect(written(parseMarkdownDocument("a\n\nb\n\nc\n").replace("b3", ""))).toBe("a\n\nb\n\n\n");
    expect(written(parseMarkdownDocument("a\n\nb\n\nc").replace("b3", ""))).toBe("a\n\nb\n\n");
    expect(written(parseMarkdownDocument("a\n\nb\n").replace("b1", ""))).toBe("\n\nb\n");
    expect(written(parseMarkdownDocument("a\n").replace("b1", ""))).toBe("\n");
    expect(written(parseMarkdownDocument("# Keep\n\nRemove ORIGINAL.\n\nTail.\n").replace("b2", ""))).toBe("# Keep\n\n\n\nTail.\n");
    expect(written(parseMarkdownDocument("\ufeff# Keep\r\n\r\nRemove\r\n\r\nTail").replace("b2", ""))).toBe("\ufeff# Keep\r\n\r\n\r\n\r\nTail");
  });

  it("keeps newlines that belong to what the editor wrote: nothing is trimmed from a replacement or an insertion", () => {
    expect(written(parseMarkdownDocument("a\n\nb\n").replace("b1", "x\n"))).toBe("x\n\n\nb\n");
    expect(written(parseMarkdownDocument("a\n\nb\n").replace("b1", "\n\nx"))).toBe("\n\nx\n\nb\n");
    // a new block's own end newlines are separators (dropped); the same newlines in a replacement are kept
    expect(written(parseMarkdownDocument("a\n\nb\n").insert("b1", "\nz\n"))).toBe("a\n\nz\n\nb\n");
  });

  it("an unclosed code fence keeps every newline of its text through an edit of its own text", () => {
    const doc = parseMarkdownDocument("```md\nORIGINAL\n\n");
    expect(doc.blocks).toHaveLength(1);
    expect(written(doc.replace("b1", doc.blockSource("b1").replace("ORIGINAL", "CHANGED")))).toBe("```md\nCHANGED\n\n");
    const more = parseMarkdownDocument("```md\nORIGINAL\n\n\nlast\n\n");
    expect(written(more.replace("b1", more.blockSource("b1").replace("ORIGINAL", "CHANGED")))).toBe("```md\nCHANGED\n\n\nlast\n\n");
    for (const [, text] of variants("```md\nORIGINAL\n\n")) {
      const d = parseMarkdownDocument(text);
      expect(written(d.replace("b1", d.blockSource("b1").replace("ORIGINAL", "X")))).toBe(text.replace("ORIGINAL", "X"));
    }
  });

  it("inserts a block after another, at the start (after front matter) and into an empty file", () => {
    const doc = parseMarkdownDocument("---\nk: v\n---\n\na\n\nb\n");
    expect(written(doc.insert("b2", "new"))).toBe("---\nk: v\n---\n\na\n\nnew\n\nb\n");
    expect(written(doc.insert("b3", "new"))).toBe("---\nk: v\n---\n\na\n\nb\n\nnew\n");
    expect(written(doc.insert("b1", "new"))).toBe("---\nk: v\n---\n\nnew\n\na\n\nb\n");
    expect(written(parseMarkdownDocument("a\n\nb").insert("b2", "z"))).toBe("a\n\nb\n\nz");
    expect(written(parseMarkdownDocument("a\n\nb\n").insert(null, "z"))).toBe("z\n\na\n\nb\n");
    expect(written(parseMarkdownDocument("").insert(null, "# Mới"))).toBe("# Mới");
    expect(written(parseMarkdownDocument("").insert(null, "# New\n\n**content**"))).toBe("# New\n\n**content**");
    expect(written(parseMarkdownDocument("\ufeff\r\n").insert(null, "x"))).toBe("\ufeffx\r\n");
    expect(written(parseMarkdownDocument("---\nk: v\n---\n").insert(null, "new"))).toBe("---\nk: v\n---\n\nnew\n");
  });

  it("keeps the order of several insertions and lists inserted blocks without a span", () => {
    let doc = parseMarkdownDocument("a\n\nb\n");
    doc = doc.insert("b1", "one");
    const first = doc.blocks[1]!;
    doc = doc.insert("b1", "two").insert(first.id, "after one");
    expect(written(doc)).toBe("a\n\ntwo\n\none\n\nafter one\n\nb\n");
    expect(doc.blocks.map((b) => b.span === null)).toEqual([false, true, true, true, false]);
    expect(doc.blocks[1]).toMatchObject({ edited: true, editable: true, construct: null, kind: "paragraph" });
    expect(() => doc.insert("nope", "x")).toThrow();
    expect(() => doc.replace("nope", "x")).toThrow();
  });
});

describe("editing the content the editor shows (AC2, AC3, AC4)", () => {
  it("changes the text of a paragraph and keeps its other marks as they were written", () => {
    const text = fixture("basic.md");
    const doc = parseMarkdownDocument(text);
    const id = blockOf(doc, "Đoạn văn có");
    const p = para(doc, id);
    const first = p.inlines[0] as Extract<MdInline, { type: "text" }>;
    const edited: MdBlock = { ...p, inlines: [{ ...first, value: first.value.replace("Đoạn văn", "Đoạn văn mới") }, ...p.inlines.slice(1)] };
    const out = written(doc.replaceNodes(id, [edited]));
    expect(out).toBe(text.replace("Đoạn văn có", "Đoạn văn mới có"));
    // the `_gạch dưới_`, the link with its title, the code and the hard break stay as written
    expect(out).toContain("_gạch dưới_");
    expect(out).toContain('[liên kết](https://example.com/a_b "Tiêu đề")');
    expect(out).toContain("ngắt dòng cứng  \ndòng ba.");
  });

  it("makes text bold and italic, with delimiters that read back", () => {
    const doc = parseMarkdownDocument("Một hai ba\n");
    const p = para(doc, "b1");
    const edited: MdBlock = {
      ...p,
      inlines: [
        { type: "text", value: "Một " },
        { type: "strong", children: [{ type: "text", value: "hai" }] },
        { type: "text", value: " " },
        { type: "emphasis", children: [{ type: "text", value: "ba" }] },
      ],
    };
    expect(written(doc.replaceNodes("b1", [edited]))).toBe("Một **hai** *ba*\n");
  });

  it("writes a new link with a destination and a title that read back", () => {
    const doc = parseMarkdownDocument("x\n");
    const link = (destination: string, title: string | null): MdBlock => ({
      type: "paragraph",
      inlines: [{ type: "link", children: [{ type: "text", value: "nhãn [1]" }], destination, title }],
    });
    for (const [destination, title] of [
      ["https://e.com/a b/c", 'Có "dấu ngoặc" và \\'],
      ["docs/a(1).md", null],
      ["docs/(unbalanced.md", "t"],
      ["", null],
      ["https://e.com/?a=1&b=2", null],
      ["https://e.com/?q=&amp;x", "&copy; title"],
      ["<angle>", null],
      ["C:\\notes\\a.md", null],
    ] as const) {
      const out = written(doc.replaceNodes("b1", [link(destination, title)]));
      const back = parseBlocks(out)[0] as Extract<MdBlock, { type: "paragraph" }>;
      expect(back.inlines[0], out).toMatchObject({ type: "link", destination, title });
    }
  });

  it("changes a link's destination and title and keeps the rest of the paragraph", () => {
    const text = "Xem [tài liệu](old.md \"Cũ\") và `mã`.\n";
    const doc = parseMarkdownDocument(text);
    const p = para(doc, "b1");
    const inlines = p.inlines.map((n) => (n.type === "link" ? { ...n, destination: "new dir/new.md", title: "Mới" } : n));
    expect(written(doc.replaceNodes("b1", [{ ...p, inlines }]))).toBe('Xem [tài liệu](<new dir/new.md> "Mới") và `mã`.\n');
  });

  it("changes a heading's level and text, a list's items and a code block", () => {
    const doc = parseMarkdownDocument("# Một\n\n- a\n- b\n\n```js\nx\n```\n");
    const h = doc.structure("b1")[0] as Extract<MdBlock, { type: "heading" }>;
    let next = doc.replaceNodes("b1", [{ ...h, level: 3, inlines: [{ type: "text", value: "Hai" }] }]);
    const list = doc.structure("b2")[0] as Extract<MdBlock, { type: "list" }>;
    const item = (t: string): MdBlock["type"] extends never ? never : Extract<MdBlock, { type: "list" }>["items"][number] => ({
      checked: null,
      children: [{ type: "paragraph", inlines: [{ type: "text", value: t }] }],
    });
    next = next.replaceNodes("b2", [{ ...list, items: [list.items[0]!, item("giữa"), list.items[1]!, item("cuối")] }]);
    const code = doc.structure("b3")[0] as Extract<MdBlock, { type: "code" }>;
    next = next.replaceNodes("b3", [{ ...code, value: "let a = `b`;\n```", info: "ts" }]);
    const out = written(next);
    expect(out).toBe("### Hai\n\n- a\n- giữa\n- b\n- cuối\n\n````ts\nlet a = `b`;\n```\n````\n");
  });

  it("keeps the unchanged items of an edited list as they were written (markers, nesting, numbering)", () => {
    const text = "3. ba\n4. bốn\n   - lồng\n   - nữa\n5. năm\n";
    const doc = parseMarkdownDocument(text);
    const list = doc.structure("b1")[0] as Extract<MdBlock, { type: "list" }>;
    const items = list.items.map((it, k) => (k === 2 ? { ...it, children: [{ type: "paragraph" as const, inlines: [{ type: "text" as const, value: "năm mươi" }] }] } : it));
    expect(written(doc.replaceNodes("b1", [{ ...list, items }]))).toBe("3. ba\n4. bốn\n   - lồng\n   - nữa\n5. năm mươi\n");
  });

  it("task list items keep their check boxes", () => {
    const doc = parseMarkdownDocument("- [ ] a\n- [x] b\n");
    const list = doc.structure("b1")[0] as Extract<MdBlock, { type: "list" }>;
    expect(list.items.map((i) => i.checked)).toEqual([false, true]);
    const flipped = { ...list, items: [{ ...list.items[0]!, checked: true, source: undefined }, list.items[1]!] };
    expect(written(doc.replaceNodes("b1", [flipped as MdBlock]))).toBe("- [x] a\n- [x] b\n");
  });

  it("edits nested Markdown: a quote holding a list holding emphasis", () => {
    const text = "> intro\n>\n> - *một*\n> - hai\n";
    const doc = parseMarkdownDocument(text);
    const q = doc.structure("b1")[0] as Extract<MdBlock, { type: "quote" }>;
    expect(q.children.map((c) => c.type)).toEqual(["paragraph", "list"]);
    const intro = q.children[0] as Extract<MdBlock, { type: "paragraph" }>;
    const out = written(doc.replaceNodes("b1", [{ ...q, children: [{ ...intro, inlines: [{ type: "text", value: "lời dẫn" }] }, q.children[1]!] }]));
    expect(out).toBe("> lời dẫn\n>\n> - *một*\n> - hai\n");
  });

  it("edits one block by Markdown text, as the editor's own conversion would (replace)", () => {
    const doc = parseMarkdownDocument("# T\n\ntext with *old*\n");
    expect(written(doc.replace("b2", "text with **new**\n\nand a second paragraph"))).toBe("# T\n\ntext with **new**\n\nand a second paragraph\n");
  });

  it("reports the unsaved state of an edit and not of its undoing (AC3)", () => {
    const doc = parseMarkdownDocument("a\n");
    const edited = doc.replace("b1", "b");
    expect(edited.edited).toBe(true);
    expect(doc.source).toBe("a\n");
    expect(edited.source).toBe("a\n");
    expect(edited.replace("b1", "a").edited).toBe(false);
  });

  it("is immutable: an edit leaves the document it came from as it was", () => {
    const doc = parseMarkdownDocument("a\n\nb\n");
    doc.replace("b1", "x");
    doc.insert("b1", "y");
    expect(doc.edited).toBe(false);
    expect(written(doc)).toBe("a\n\nb\n");
    expect(doc.blocks).toHaveLength(2);
  });
});

describe("new text is escaped and read back (AC5)", () => {
  const roundtrip = (value: string): void => {
    const doc = parseMarkdownDocument("x\n");
    const out = written(doc.replaceNodes("b1", [{ type: "paragraph", inlines: [{ type: "text", value }] }]));
    const back = parseBlocks(out);
    expect(back, out).toHaveLength(1);
    const p = back[0]!;
    expect(p.type).toBe("paragraph");
    const text = (p as Extract<MdBlock, { type: "paragraph" }>).inlines.map((n) => (n.type === "text" ? n.value : n.type === "softbreak" ? "\n" : `<${n.type}>`)).join("");
    expect(text).toBe(value);
  };

  it("escapes the characters that would make marks", () => {
    for (const v of [
      "*not bold*", "_not italic_", "snake_case_name", "`code`", "[x](y)", "![img](a.png)", "<b>html</b>", "<https://a.b>", "back\\slash", "a & b", "&amp; and &#35;",
      "~~strike~~ and ~one~", "[ref]", "line with trailing backslash\\", "1 * 2 * 3", "a_b_ c", "end with #",
    ]) roundtrip(v);
  });

  it("escapes what would start a block at the start of a line", () => {
    for (const v of ["# heading", "## h", "> quote", "- item", "+ item", "* item", "1. item", "12) item", "---", "===", "___", "~~~", "```js", "| a | b |", "|---|---|", "-", "#"]) roundtrip(v);
    for (const v of ["first\n# heading", "first\n- item", "first\n---", "first\n1. x", "first\n> q"]) roundtrip(v);
  });

  it("writes text that is only spaces or empty as no block", () => {
    const doc = parseMarkdownDocument("x\n\ny\n");
    expect(written(doc.replaceNodes("b1", [{ type: "paragraph", inlines: [{ type: "text", value: "  " }] }]))).toBe("\n\ny\n");
  });

  it("chooses a code span delimiter that cannot clash with the code", () => {
    expect(renderCodeSpan("a")).toBe("`a`");
    expect(renderCodeSpan("a`b")).toBe("``a`b``");
    expect(renderCodeSpan("`a")).toBe("`` `a ``");
    expect(renderCodeSpan("a``b`c")).toBe("```a``b`c```");
    expect(renderCodeSpan(" a ")).toBe("`  a  `");
    for (const v of ["a", "a`b", "`", "``", " x ", "a``b`c", "x ` y", "``` ``"]) {
      const doc = parseMarkdownDocument("x\n");
      const out = written(doc.replaceNodes("b1", [{ type: "paragraph", inlines: [{ type: "code", value: v }] }]));
      expect((parseBlocks(out)[0] as Extract<MdBlock, { type: "paragraph" }>).inlines[0], out).toMatchObject({ type: "code", value: v });
    }
  });

  it("chooses a fence longer than any run of backticks in the code, or tildes when the info has a backtick", () => {
    expect(renderFence("x", "")).toBe("```\nx\n```");
    expect(renderFence("```\ninner\n```", "md")).toBe("````md\n```\ninner\n```\n````");
    expect(renderFence("a\n`````\nb", "")).toBe("``````\na\n`````\nb\n``````");
    expect(renderFence("x", "a`b")).toBe("~~~a`b\nx\n~~~");
    expect(renderFence("~~~\nx", "a`b")).toBe("~~~~a`b\n~~~\nx\n~~~~");
    expect(renderFence("", "")).toBe("```\n```");
    for (const [value, info] of [["", ""], ["x", "js"], ["```\n~~~", ""], ["a\n\n\nb", "ts"], ["  indented\n\ttab", ""], ["```", "x`y"]] as const) {
      const doc = parseMarkdownDocument("x\n");
      const out = written(doc.replaceNodes("b1", [{ type: "code", value, info, fence: null }]));
      expect(parseBlocks(out)[0], out).toMatchObject({ type: "code", value, info });
    }
  });

  it("refuses text that cannot be written as UTF-8", () => {
    const doc = parseMarkdownDocument("a\n");
    expect(refusal(doc.replace("b1", "a\u0000b"))).toMatchObject([{ code: "unwritable-text", line: 1 }]);
    expect(refusal(doc.replace("b1", "a\ud800b"))).toMatchObject([{ code: "unwritable-text" }]);
    expect(refusal(doc.insert("b1", "x\udfff"))).toMatchObject([{ code: "unwritable-text" }]);
    expect(written(doc.replace("b1", "a 😀 b"))).toBe("a 😀 b\n");
  });
});

describe("what cannot be written safely is refused with no text (guarantee 3)", () => {
  it("refuses an edit inside raw HTML, a table, front matter, a definition and a footnote, naming the construct and the line", () => {
    const text = fixture("constructs.md");
    const doc = parseMarkdownDocument(text);
    for (const construct of ["html block", "table", "front matter", "link reference definition", "footnote definition"]) {
      const id = doc.blocks.find((b) => b.construct === construct)!.id;
      const r = refusal(doc.replace(id, "changed"));
      expect(r[0]).toMatchObject({ code: "unsupported-construct", construct });
      expect(r[0]!.line).toBe(doc.blocks.find((b) => b.id === id) && text.slice(0, doc.blocks.find((b) => b.id === id)!.span!.start).split("\n").length);
      expect(r[0]!.message).toContain("Line ");
    }
  });

  it("an undone edit in such a block is no edit and saving is allowed again", () => {
    const doc = parseMarkdownDocument(fixture("constructs.md"));
    const html = doc.blocks.find((b) => b.construct === "html block")!;
    const bad = doc.replace(html.id, "x");
    expect(bad.serialize().ok).toBe(false);
    const good = bad.replace(html.id, doc.blockSource(html.id));
    expect(good.edited).toBe(false);
    expect(written(good)).toBe(fixture("constructs.md"));
  });

  it("refuses an edit that writes raw HTML, a table or front matter-like constructs it cannot read back as edited", () => {
    const doc = parseMarkdownDocument("a\n");
    expect(refusal(doc.replace("b1", "<div>x</div>"))).toMatchObject([{ code: "unsupported-construct", construct: "html block" }]);
    expect(refusal(doc.replace("b1", "| a | b |\n|---|---|\n| 1 | 2 |"))).toMatchObject([{ code: "unsupported-construct", construct: "table" }]);
    expect(refusal(doc.insert("b1", "[x]: http://y"))).toMatchObject([{ code: "unsupported-construct", construct: "link reference definition" }]);
  });

  it("refuses an edit that would swallow the blocks after it (an unclosed fence, an open comment)", () => {
    const doc = parseMarkdownDocument("a\n\nb\n\nc\n");
    const r = refusal(doc.replace("b1", "```js\ncode"));
    expect(r[0]).toMatchObject({ code: "roundtrip-mismatch", line: 1 });
    expect(refusal(doc.replace("b2", "<!-- open")) [0]!.code).toBe("unsupported-construct");
  });

  it("refuses an edit that would join the list after it", () => {
    const doc = parseMarkdownDocument("para\n\n- a\n- b\n");
    expect(refusal(doc.replace("b1", "- x\n- y"))[0]).toMatchObject({ code: "roundtrip-mismatch" });
    expect(written(doc.replace("b1", "* x\n* y"))).toBe("* x\n* y\n\n- a\n- b\n");
  });

  it("refuses a tree that cannot be written so that it reads back as the same tree", () => {
    const doc = parseMarkdownDocument("x\n");
    // emphasis whose edge touches a letter and a quote cannot open with `*`
    const bad: MdBlock = { type: "paragraph", inlines: [{ type: "text", value: "a" }, { type: "emphasis", children: [{ type: "text", value: '"q"' }] }, { type: "text", value: "b" }] };
    const r = refusal(doc.replaceNodes("b1", [bad]));
    expect(r[0]).toMatchObject({ code: "roundtrip-mismatch", line: 1 });
  });

  it("refusing keeps the edits: the document still holds them", () => {
    const doc = parseMarkdownDocument("a\n").replace("b1", "a\u0000");
    expect(doc.edited).toBe(true);
    expect(doc.blockSource("b1")).toBe("a\u0000");
  });

  it("lists every reason", () => {
    const doc = parseMarkdownDocument("<div>x</div>\n\na\n");
    const r = refusal(doc.replace("b1", "y").replace("b2", "z\u0000"));
    expect(r.map((x) => x.code).sort()).toEqual(["unsupported-construct", "unwritable-text"]);
  });
});

describe("Markdown it does not edit is kept, not turned into text (guarantee 4)", () => {
  it("keeps images, inline HTML, autolinks, reference links and footnote references as raw marks", () => {
    const doc = parseMarkdownDocument(fixture("constructs.md"));
    const id = blockOf(doc, "tham chiếu");
    const p = para(doc, id);
    const raws = p.inlines.filter((n) => n.type === "raw").map((n) => (n as Extract<MdInline, { type: "raw" }>).construct);
    expect(raws).toEqual(["reference link", "reference link", "image", "autolink", "inline html", "inline html", "footnote reference"]);
    const first = p.inlines[0] as Extract<MdInline, { type: "text" }>;
    const out = written(doc.replaceNodes(id, [{ ...p, inlines: [{ ...first, value: "Đổi " + first.value }, ...p.inlines.slice(1)] }]));
    expect(out).toBe(fixture("constructs.md").replace("Một đoạn dùng", "Đổi Một đoạn dùng"));
  });

  it("does not turn an unknown syntax into escaped text when only another part of the text changed", () => {
    const text = "Có ~~gạch~~ và [[wiki]] và $x_1$ và https://a.com/a_b_c rồi *đây*.\n";
    const doc = parseMarkdownDocument(text);
    const p = para(doc, "b1");
    const inlines = p.inlines.map((n) => (n.type === "emphasis" ? { type: "emphasis" as const, children: [{ type: "text" as const, value: "kia" }] } : n));
    expect(written(doc.replaceNodes("b1", [{ ...p, inlines }]))).toBe(text.replace("*đây*", "*kia*"));
    // and the same when the text node next to them changes
    const first = p.inlines[0] as Extract<MdInline, { type: "text" }>;
    const out = written(doc.replaceNodes("b1", [{ ...p, inlines: [{ ...first, value: first.value.replace("Có", "Chỉ có") }, ...p.inlines.slice(1)] }]));
    expect(out).toBe(text.replace("Có", "Chỉ có"));
  });

  it("keeps entities and escapes inside text that is edited elsewhere", () => {
    const text = "Dấu \\* thoát và &amp; thực thể, &copy; và \\_x\\_ cuối.\n";
    const doc = parseMarkdownDocument(text);
    const p = para(doc, "b1");
    const t = p.inlines[0] as Extract<MdInline, { type: "text" }>;
    expect(t.value).toBe("Dấu * thoát và & thực thể, © và _x_ cuối.");
    const out = written(doc.replaceNodes("b1", [{ ...p, inlines: [{ ...t, value: t.value + " Thêm [1]." }] }]));
    expect(out).toBe("Dấu \\* thoát và &amp; thực thể, &copy; và \\_x\\_ cuối. Thêm \\[1\\].\n");
  });

  it("keeps a setext heading, indented code, front matter and HTML when other blocks are edited", () => {
    const text = fixture("constructs.md");
    const doc = parseMarkdownDocument(text);
    const id = blockOf(doc, "[ ] việc chưa xong");
    const list = doc.structure(id)[0] as Extract<MdBlock, { type: "list" }>;
    expect(list.items.map((i) => i.checked)).toEqual([false, true, null]);
    const out = written(doc.replace(id, "- [ ] việc mới"));
    expect(out).toBe(text.replace(/- \[ \] việc chưa xong\n- \[x\] việc đã xong\n- việc thường/, "- [ ] việc mới"));
    expect(out).toContain("Setext tiêu đề\n==============");
    expect(out).toContain("    mã thụt lề\n    dòng hai");
  });
});

describe("what the reader sees of Markdown", () => {
  const kinds = (src: string): string[] => parseBlocks(src).map((b) => b.type + (b.type === "raw" ? `:${b.construct}` : ""));

  it("cuts blocks the way CommonMark does", () => {
    expect(kinds("# a\ntext\n\n- x\n- y\n\n> q\n\n```\nc\n```\n\n---\n")).toEqual(["heading", "paragraph", "list", "quote", "code", "rule"]);
    expect(kinds("a\nb\n---\n")).toEqual(["heading"]);
    expect(kinds("a\n***\nb")).toEqual(["paragraph", "rule", "paragraph"]);
    expect(kinds("text\n- item\n")).toEqual(["paragraph", "list"]);
    expect(kinds("text\n2. not a list\n")).toEqual(["paragraph"]);
    expect(kinds("1. item\n   continued\n\n   more\n2. two")).toEqual(["list"]);
    expect(kinds("- a\n\n\n- b")).toEqual(["list"]);
    expect(kinds("- a\n* b")).toEqual(["list", "list"]);
    expect(kinds("1. a\n1) b")).toEqual(["list", "list"]);
    expect(kinds("> a\nlazy\n\nafter")).toEqual(["quote", "paragraph"]);
    expect(kinds("```\nunclosed\n\nstill code")).toEqual(["code"]);
    expect(kinds("    code\n\n    more\nnot code")).toEqual(["code", "paragraph"]);
    expect(kinds("a | b\n--|--\n1 | 2\n\ntext")).toEqual(["raw:table", "paragraph"]);
    expect(kinds("intro line\na | b\n--|--\n1 | 2")).toEqual(["paragraph", "raw:table"]);
    expect(kinds("<div>\n\ntext\n\n<!-- c\nd -->\ne")).toEqual(["raw:html block", "paragraph", "raw:html block", "paragraph"]);
    expect(kinds("<span>x</span> inline at the start")).toEqual(["paragraph"]);
    expect(kinds("[a]: /u\n[b]: /v \"t\"\ntext")).toEqual(["raw:link reference definition", "raw:link reference definition", "paragraph"]);
    expect(kinds("text\n[a]: /u")).toEqual(["paragraph"]);
    expect(kinds("[^1]: note\n    more\n\ntext")).toEqual(["raw:footnote definition", "paragraph"]);
  });

  it("does not take a thematic break, a lone dash or a `---` in the body for front matter", () => {
    expect(kinds("---\ntitle\n")).toEqual(["rule", "paragraph"]);
    expect(kinds("text\n\n---\nk: v\n---\n")).toEqual(["paragraph", "rule", "heading"]);
  });

  it("reads emphasis by the delimiter rules", () => {
    const shape = (s: string): string => JSON.stringify(parseInlines(s).map((n) => (n.type === "text" ? n.value : { [n.type]: "children" in n ? n.children.map((c) => (c.type === "text" ? c.value : c.type)) : "" })));
    expect(shape("*a*")).toBe('[{"emphasis":["a"]}]');
    expect(shape("**a**")).toBe('[{"strong":["a"]}]');
    expect(shape("***a***")).toBe('[{"emphasis":["strong"]}]');
    expect(shape("snake_case_name")).toBe('["snake_case_name"]');
    expect(shape("2 * 3 * 4")).toBe('["2 * 3 * 4"]');
    expect(shape("*a **b** c*")).toBe('[{"emphasis":["a ","strong"," c"]}]');
    expect(shape("a*b*c")).toBe('["a",{"emphasis":["b"]},"c"]');
    expect(shape("**a*")).toBe('["*",{"emphasis":["a"]}]');
    expect(shape("_a_b")).toBe('["_a_b"]');
  });

  it("reads links, images and code spans", () => {
    const one = (s: string): MdInline => parseInlines(s)[0]!;
    expect(one("[a](b)")).toMatchObject({ type: "link", destination: "b", title: null });
    expect(one("[a](<b c> 'T')")).toMatchObject({ destination: "b c", title: "T" });
    expect(one("[a](b(c)d \"t\")")).toMatchObject({ destination: "b(c)d" });
    expect(one("[a](b\\)c)")).toMatchObject({ destination: "b)c" });
    expect(one("[a]()")).toMatchObject({ destination: "" });
    expect(one("[a](/u?x=1&amp;y=2)")).toMatchObject({ destination: "/u?x=1&y=2" });
    expect(one("[a [b] c](d)")).toMatchObject({ type: "link" });
    expect(parseInlines("[a](b c)")).toMatchObject([{ type: "text" }]);
    expect(one("![a](b)")).toMatchObject({ type: "raw", construct: "image" });
    expect(one("[![i](a.png)](b)")).toMatchObject({ type: "link" });
    expect(one("`a  b`")).toMatchObject({ type: "code", value: "a  b" });
    expect(one("`` a`b ``")).toMatchObject({ type: "code", value: "a`b" });
    expect(one("` `` `")).toMatchObject({ type: "code", value: "``" });
    expect(parseInlines("`unclosed")).toMatchObject([{ type: "text", value: "`unclosed" }]);
  });

  it("keeps the text of an escape and an entity, and the pieces that make it", () => {
    expect(parseInlines("a \\* b &lt; c &#x41; &unknown; d")).toMatchObject([{ type: "text", value: "a * b < c A &unknown; d" }]);
  });

  it("normalizes: blanks at the edges of a line leave, blanks inside emphasis move out", () => {
    const n = normalizeInlines(
      [{ type: "text", value: "  a " }, { type: "softbreak" }, { type: "text", value: "  b  " }, { type: "strong", children: [{ type: "text", value: " c " }] }, { type: "break" }],
      true,
    );
    expect(n.map((x) => (x.type === "text" ? x.value : x.type))).toEqual(["a", "softbreak", "b   ", "strong"]);
  });

  it("escapeText leaves ordinary text alone", () => {
    expect(escapeText("Xin chào, thế giới! 100% (ok) — 'q' \"d\" a-b 3.14 #tag a@b.c")).toBe("Xin chào, thế giới! 100% (ok) — 'q' \"d\" a-b 3.14 #tag a@b.c");
    expect(escapeText("a_b")).toBe("a_b");
    expect(escapeText("a & b")).toBe("a & b");
  });
});

describe("rendering whole trees", () => {
  it("renderBlocks writes blocks apart by one blank line and reads back as the same blocks", () => {
    const nodes = parseBlocks(fixture("basic.md"));
    const md = renderBlocks(nodes);
    expect(md).toBe(fixture("basic.md").replace(/\n+$/, "").replace(/\n{2,}/g, "\n\n"));
    const fresh = nodes.map((n) => JSON.parse(JSON.stringify(n, (k, v) => (k === "source" ? undefined : v))) as MdBlock);
    const again = renderBlocks(fresh);
    expect(parseBlocks(again).map((b) => b.type)).toEqual(nodes.map((b) => b.type));
  });

  it("a tree with no source at all is written fresh and reads back the same (nested)", () => {
    const nodes: MdBlock[] = [
      { type: "heading", level: 2, inlines: [{ type: "text", value: "Tiêu đề # 1" }] },
      {
        type: "list", ordered: true, start: 3, marker: ".", tight: true,
        items: [
          { checked: null, children: [{ type: "paragraph", inlines: [{ type: "text", value: "một" }] }, { type: "list", ordered: false, start: 0, marker: "-", tight: true, items: [{ checked: null, children: [{ type: "paragraph", inlines: [{ type: "strong", children: [{ type: "text", value: "lồng" }] }] }] }] }] },
          { checked: true, children: [{ type: "paragraph", inlines: [{ type: "text", value: "xong" }] }, { type: "code", value: "a\n\nb", info: "", fence: null }] },
        ],
      },
      { type: "quote", children: [{ type: "paragraph", inlines: [{ type: "text", value: "q1" }, { type: "softbreak" }, { type: "text", value: "q2" }] }, { type: "code", value: "x", info: "js", fence: null }] },
      { type: "rule" },
    ];
    const doc = parseMarkdownDocument("x\n");
    const out = written(doc.replaceNodes("b1", nodes));
    expect(out).toBe("## Tiêu đề # 1\n\n3. một\n   - **lồng**\n4. [x] xong\n\n   ```\n   a\n\n   b\n   ```\n\n> q1\n> q2\n>\n> ```js\n> x\n> ```\n\n---\n");
  });
});

describe("robustness", () => {
  it("never loses a byte of any prefix of the fixtures when read and written back", () => {
    for (const name of fixtures) {
      const text = fixture(name);
      for (let cut = 0; cut <= text.length; cut += 7) {
        const part = text.slice(0, cut);
        expect(written(parseMarkdownDocument(part))).toBe(part);
      }
    }
  });

  it("an edit of any editable block of any fixture reads back and changes only that block", () => {
    for (const name of fixtures) {
      for (const [, text] of variants(fixture(name))) {
        const doc = parseMarkdownDocument(text);
        for (const b of doc.blocks.filter((x) => x.editable)) {
          const out = written(doc.replace(b.id, doc.blockSource(b.id) + "\n\nextra paragraph"));
          const lf = (s: string): string => s.replace(/\r\n|\r/g, "\n");
          const expected = text.slice(0, b.span!.start) + (doc.blockSource(b.id) + "\n\nextra paragraph").replace(/\n/g, /\r\n|\r|\n/.exec(text.slice(b.span!.start, b.span!.end))?.[0] ?? /\r\n|\r|\n/.exec(text)?.[0] ?? "\n") + text.slice(b.span!.end);
          expect(lf(out), `${name} ${b.id}`).toBe(lf(expected));
        }
      }
    }
  });

  it("handles pathological input without hanging", () => {
    const evil = ["*".repeat(5000), "[".repeat(3000) + "a" + "]".repeat(3000), "`".repeat(2000), "> ".repeat(500) + "x", "- ".repeat(300) + "x", "<".repeat(3000), "a\n".repeat(5000)];
    for (const text of evil) {
      const t0 = Date.now();
      const doc = parseMarkdownDocument(text);
      expect(written(doc)).toBe(text);
      for (const b of doc.blocks) doc.structure(b.id);
      expect(Date.now() - t0).toBeLessThan(5000);
    }
  });
});

describe("details that went wrong while building it", () => {
  it("a list marker after a nested list is the next item, not a lazy line of the nested one", () => {
    expect(parseBlocks("4. a\n   - b\n5. c")).toMatchObject([{ type: "list", items: [{}, {}] }]);
  });

  it("keeps ~~strikethrough~~ as one mark, also when its neighbours are rewritten fresh", () => {
    const doc = parseMarkdownDocument("Có ~~gạch ngang~~ ở đây.\n");
    const p = para(doc, "b1");
    expect(p.inlines.map((n) => n.type)).toEqual(["text", "raw", "text"]);
    const fresh = JSON.parse(JSON.stringify(p.inlines, (k, v) => (k === "source" && !(typeof v === "string" && v.startsWith("~~")) ? undefined : v))) as MdInline[];
    (fresh[0] as { value: string }).value = "Không có ";
    expect(written(doc.replaceNodes("b1", [{ type: "paragraph", inlines: fresh }]))).toBe("Không có ~~gạch ngang~~ ở đây.\n");
  });

  it("a line break inside a text value is a soft break", () => {
    const doc = parseMarkdownDocument("x\n");
    expect(written(doc.replaceNodes("b1", [{ type: "paragraph", inlines: [{ type: "text", value: "a\n# b" }] }]))).toBe("a\n\\# b\n");
  });

  it("refuses an edit whose neighbour touches it with no blank line between and would merge with it", () => {
    const doc = parseMarkdownDocument("# T\ntext\n");
    expect(written(doc.replace("b1", "# U"))).toBe("# U\ntext\n");
    expect(refusal(doc.replace("b1", "U"))[0]).toMatchObject({ code: "roundtrip-mismatch" });
  });

  it("opens a file whose structure it cannot read as one block that is shown whole and cannot be edited", () => {
    const doc = parseMarkdownDocument("<!-- never closed\n\n# not a heading\n");
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]).toMatchObject({ editable: false, construct: "html block" });
    expect(refusal(doc.replace("b1", "x"))[0]).toMatchObject({ code: "unsupported-construct", line: 1 });
    expect(written(doc)).toBe("<!-- never closed\n\n# not a heading\n");
  });
});

describe("property check: random documents and random edits", () => {
  let seed = 20261118;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
  const lines = [
    "# H", "## H *x*", "text", "more text **b**", "- a", "- b", "  - n", "1. x", "2. y", "> q", "> - l", "```", "```js", "~~~", "    code", "---", "***", "", "", "",
    "<div>", "</div>", "<!--", "-->", "| a | b |", "|---|---|", "[r]: /u", "[^1]: n", "[r] and [x][r]", "a  ", "b\\", "===", "   - z", "\t- t", "*", "-", "+ p", "3) c",
    "![i](a)", "`c`", "***b***", "_u_", "[l](<a b> 't')", "&amp; \\*", "~~s~~",
  ];
  const replacements = ["x", "# new", "- i\n- j", "```\nc\n```", "para *e*\n\nsecond", "", "> q", "```js\nunclosed", "<div>", "a\n---", "a\u0000"];

  it("reads every text back unchanged, and a write changes only the edited block, never a block that is not editable", () => {
    let wrote = 0;
    for (let iter = 0; iter < 700; iter++) {
      const eol = pick(["\n", "\r\n", "\r"]);
      let text = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => pick(lines)).join(eol);
      if (rnd() < 0.5) text += eol;
      if (rnd() < 0.2) text = "\ufeff" + text;
      const doc = parseMarkdownDocument(text);
      expect(written(doc)).toBe(text);
      for (const b of doc.blocks) {
        expect(b.span).not.toBeNull();
        doc.structure(b.id);
        const repl = pick(replacements);
        const next = doc.replace(b.id, repl);
        const r = next.serialize();
        if (!next.edited || !r.ok) continue;
        wrote++;
        expect(b.editable, JSON.stringify([text, b.id, repl])).toBe(true);
        if (repl !== "") expect(r.text.startsWith(text.slice(0, b.span!.start)), JSON.stringify([text, b.id, repl, r.text])).toBe(true);
        if (repl !== "") expect(r.text.endsWith(text.slice(b.span!.end)) || b.span!.end === text.length, JSON.stringify([text, b.id, repl, r.text])).toBe(true);
        expect(r.text).not.toContain("\u0000");
      }
    }
    expect(wrote).toBeGreaterThan(500);
  });
});


describe("a link reference definition is one immutable region, however many lines it takes (AC5 regression)", () => {
  const cases: [string, string, number][] = [
    ["title on the next line", '[ref]: /url\n  "Original title"\n\nSee [label][ref].\n', 2],
    ["destination on the next line", "[ref]:\n  /url\n\nSee [label][ref].\n", 2],
    ["destination and title on their own lines", '[ref]:\n  /url\n  "Original title"\n\nSee [label][ref].\n', 3],
    ["a title over two lines", "[ref]: /url 'first\nsecond'\n\nSee [label][ref].\n", 2],
    ["a title in parentheses on the next line", "[ref]: </my url>\n(Original title)\n\nSee [label][ref].\n", 2],
    ["a label over two lines", '[a\nref]: /url "T"\n\nSee [label][a ref].\n', 2],
    ["two definitions in a row, the first with a title line", '[one]: /1\n"t"\n[two]: /2\n\nSee [label][one] and [two].\n', 3],
  ];

  for (const [label, src, defLines] of cases) {
    for (const [variant, text] of variants(src)) {
      it(`${label}, ${variant}: the definition is one block that cannot be edited, and an edit next to it leaves it as it was`, () => {
        const doc = parseMarkdownDocument(text);
        const defs = doc.blocks.filter((b) => b.construct === "link reference definition");
        expect(defs.length).toBeGreaterThan(0);
        // together the definitions cover all their lines: the block after them is the paragraph
        const lastDef = defs[defs.length - 1]!;
        const covered = text.slice(defs[0]!.span!.start, lastDef.span!.end).split(/\r\n|\r|\n/).length;
        expect(covered).toBe(defLines);
        const paragraph = doc.blocks.find((b) => b.kind === "paragraph" && doc.blockSource(b.id).includes("See"))!;
        expect(paragraph.editable).toBe(true);
        expect(doc.blocks.filter((b) => b.editable).map((b) => b.id)).toEqual([paragraph.id]);
        // wrap the paragraph's content in strong, as the editor does: the definition lines stay byte for byte
        const p = para(doc, paragraph.id);
        const out = written(doc.replaceNodes(paragraph.id, [{ ...p, inlines: [{ type: "strong", children: p.inlines }] }]));
        const after = parseMarkdownDocument(out);
        const eol = /\r\n|\r|\n/.exec(text)?.[0] ?? "\n";
        expect(out.startsWith(text.slice(0, paragraph.span!.start))).toBe(true);
        expect(out).toContain("**See ");
        expect(after.blocks.filter((b) => b.construct === "link reference definition").map((b) => after.blockSource(b.id))).toEqual(
          defs.map((b) => doc.blockSource(b.id)),
        );
        // and no title line has become a paragraph
        expect(after.blocks.filter((b) => b.kind === "paragraph")).toHaveLength(1);
        void eol;
        // an edit inside the definition is refused, naming it
        const r = refusal(doc.replace(defs[0]!.id, "[ref]: /other"));
        expect(r[0]).toMatchObject({ code: "unsupported-construct", construct: "link reference definition", line: 1 + (text.replace(/^﻿/, "").slice(0, defs[0]!.span! .start - (text.startsWith("﻿") ? 1 : 0)).split(/\r\n|\r|\n/).length - 1) });
      });
    }
  }

  it("a title line that is not a title is a paragraph after the definition", () => {
    const doc = parseMarkdownDocument('[a]: /u\n"t" junk\n\n[b]: /v\n');
    expect(doc.blocks.map((b) => [b.kind, doc.blockSource(b.id)])).toEqual([
      ["other", "[a]: /u"],
      ["paragraph", '"t" junk'],
      ["other", "[b]: /v"],
    ]);
  });

  it("a definition that does not hold together is a paragraph, as in CommonMark", () => {
    for (const text of ["[a]:\n\nnext", "[a]: <b\n\nx", "[a] : /u", "[]: /u", "[a]: /u 'unclosed"]) {
      const kinds = parseBlocks(text).map((b) => b.type);
      expect(kinds, text).not.toContain("raw");
    }
  });

  it("a definition inside a list item or a quote makes that block not editable, whole", () => {
    for (const text of ['- [r]: /u\n  "title"\n\n  text\n', '> [r]: /u\n> "title"\n>\n> text\n']) {
      const doc = parseMarkdownDocument(text);
      expect(doc.blocks).toHaveLength(1);
      expect(doc.blocks[0]).toMatchObject({ editable: false, construct: "link reference definition" });
      expect(refusal(doc.replace("b1", "x"))[0]).toMatchObject({ code: "unsupported-construct" });
      expect(written(doc)).toBe(text);
    }
  });

  it("links to the definition keep resolving to it: a paragraph written next to it keeps `[x][ref]` as a reference link", () => {
    const doc = parseMarkdownDocument('[ref]: /url\n  "Original title"\n\nSee [label][ref].\n');
    expect(doc.labels.has("ref")).toBe(true);
    expect(para(doc, "b2").inlines.some((n) => n.type === "raw" && n.construct === "reference link")).toBe(true);
  });
});

describe("a definition of any length is one immutable region (no fixed limit)", () => {
  const body = (n: number): string => Array.from({ length: n }, (_, k) => `line ${k + 1} of the title`).join("\n");
  for (const n of [11, 12, 13, 14, 50, 3000]) {
    for (const [variant, text] of variants(`[ref]: /url "first\n${body(n)}\nlast"\n\nSee [ref].\n`)) {
      it(`a title over ${n + 2} lines, ${variant}`, () => {
        const doc = parseMarkdownDocument(text);
        expect(doc.blocks.map((b) => [b.kind, b.editable, b.construct])).toEqual([
          ["other", false, "link reference definition"],
          ["paragraph", true, null],
        ]);
        const defText = text.slice(doc.blocks[0]!.span!.start, doc.blocks[0]!.span!.end);
        expect(defText.split(/\r\n|\r|\n/)).toHaveLength(n + 2);
        const p = para(doc, "b2");
        expect(p.inlines.some((x) => x.type === "raw" && x.construct === "reference link")).toBe(true);
        const out = written(doc.replaceNodes("b2", [{ ...p, inlines: [{ type: "strong", children: p.inlines }] }]));
        expect(out.startsWith(text.slice(0, doc.blocks[1]!.span!.start))).toBe(true);
        expect(out).toContain("**See [ref].**");
        expect(refusal(doc.replace("b1", "[ref]: /other"))[0]).toMatchObject({ code: "unsupported-construct", construct: "link reference definition", line: 1 });
      });
    }
  }

  it("a label, a destination line and a title that each take many lines", () => {
    const label = Array.from({ length: 40 }, (_, k) => `word${k}`).join("\n");
    const text = `[${label}]:\n  /url\n  'a\n${body(30)}\nb'\n\n[x]\n`;
    const doc = parseMarkdownDocument(text);
    expect(doc.blocks.map((b) => b.construct)).toEqual(["link reference definition", null]);
    expect(doc.blocks[0]!.span!.end).toBe(text.indexOf("b'") + 2);
  });

  it("a run of many definitions is read in linear time and each stays whole", () => {
    const text = Array.from({ length: 5000 }, (_, k) => `[r${k}]: /u${k}\n"t${k}"`).join("\n") + "\n\ntext\n";
    const t0 = Date.now();
    const doc = parseMarkdownDocument(text);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(doc.blocks).toHaveLength(5001);
    expect(doc.blocks.slice(0, 5000).every((b) => b.construct === "link reference definition" && !b.editable)).toBe(true);
    expect(doc.labels.has("r4999")).toBe(true);
  });

  it("a very long line that starts like a definition but is not one does not hang", () => {
    for (const text of ["[" + "a".repeat(1_000_000), "[" + "a ".repeat(500_000) + "]", "[a]: " + "<" + "x".repeat(500_000)]) {
      const t0 = Date.now();
      const doc = parseMarkdownDocument(text);
      expect(written(doc)).toBe(text);
      expect(Date.now() - t0).toBeLessThan(3000);
    }
  });
});

describe("a block that was not edited is copied byte for byte, whatever line endings it holds (AC5 regression)", () => {
  it("keeps a LF inside a CRLF code block when another block is replaced", () => {
    const text = "```\r\nfirst\nsecond\r\n```\r\n\r\nold\r\n";
    const out = written(parseMarkdownDocument(text).replace("b2", "new"));
    expect(out).toBe("```\r\nfirst\nsecond\r\n```\r\n\r\nnew\r\n");
  });

  it("keeps mixed endings, lone CR and a final line of its own kind in every block that is not edited, also around insertions and removals", () => {
    const text = "﻿a\nb\r\nc\r\n\r\n```\r\nx\ny\rz\n```\n\n- i\r\n- j\n\r\nold\n";
    const doc = parseMarkdownDocument(text);
    const ids = doc.blocks.map((b) => b.id);
    const raw = (id: string): string => {
      const b = doc.blocks.find((x) => x.id === id)!;
      return text.slice(b.span!.start, b.span!.end);
    };
    for (const id of ids) {
      for (const next of [doc.replace(id, "changed"), doc.insert(id, "added"), doc.replace(id, "")]) {
        const out = written(next);
        for (const other of ids.filter((x) => x !== id)) expect(out, `${id} / ${other}`).toContain(raw(other));
      }
    }
    expect(written(doc.replace(ids[ids.length - 1]!, "new"))).toBe(text.replace("old", "new"));
  });

  it("property: every block that is not edited is in the output as its own bytes", () => {
    let seed = 777;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
    const lines = ["# H", "text", "- a", "> q", "```", "code", "---", "", "", "[r]: /u", '"t"', "<div>", "| a | b |", "|---|---|"];
    const eols = ["\n", "\r\n", "\r"];
    for (let iter = 0; iter < 500; iter++) {
      let text = "";
      for (let k = 0, n = 2 + Math.floor(rnd() * 12); k < n; k++) text += pick(lines) + pick(eols);
      const doc = parseMarkdownDocument(text);
      for (const b of doc.blocks.filter((x) => x.editable)) {
        const r = doc.replace(b.id, pick(["x", "# y", "a\nb"])).serialize();
        if (!r.ok) continue;
        for (const o of doc.blocks.filter((x) => x.id !== b.id)) expect(r.text, JSON.stringify([text, b.id, o.id])).toContain(text.slice(o.span!.start, o.span!.end));
      }
    }
  });
});

describe("the output is the source with operations at places in it (R32)", () => {
  /** The expected text built a second way: cut and paste on the original, from the last place to the first. */
  const spliced = (text: string, ops: { start: number; end: number; with: string }[]): string => {
    let out = text;
    for (const op of [...ops].sort((a, b) => b.start - a.start)) out = out.slice(0, op.start) + op.with + out.slice(op.end);
    return out;
  };

  it("several edits at once touch only their own places: the BOM, the gaps and the end of the file stay", () => {
    const text = "﻿\n  \n# One\r\n\r\n\r\ntwo\r\n\r\n- three\r\n\r\n\r\n";
    const doc = parseMarkdownDocument(text);
    const [one, two, three] = doc.blocks;
    const next = doc.replace(one!.id, "# 1").replace(three!.id, "").insert(two!.id, "after two");
    expect(written(next)).toBe(
      spliced(text, [
        { start: one!.span!.start, end: one!.span!.end, with: "# 1" },
        { start: two!.span!.end, end: two!.span!.end, with: "\r\n\r\nafter two" },
        { start: three!.span!.start, end: three!.span!.end, with: "" },
      ]),
    );
  });

  it("property: with random edits the output is the source cut and pasted at the blocks' own places", () => {
    let seed = 4242;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
    const parts = ["# H", "text", "- a", "> q", "---", "```\ncode\n```", "<div>", "[r]: /u", "| a |\n|---|"];
    let checked = 0;
    for (let iter = 0; iter < 600; iter++) {
      const eol = pick(["\n", "\r\n"]);
      const gap = (): string => pick(["\n\n", "\n\n\n", "\n \n", "\n\n\n\n"]).replace(/\n/g, eol);
      let text = pick(["", "﻿", gap(), "﻿" + gap()]);
      for (let k = 0, n = 1 + Math.floor(rnd() * 5); k < n; k++) text += pick(parts).replace(/\n/g, eol) + (k < n - 1 ? gap() : pick(["", eol, eol + eol, eol + "  " + eol]));
      const doc = parseMarkdownDocument(text);
      let next = doc;
      const ops: { start: number; end: number; with: string }[] = [];
      for (const b of doc.blocks.filter((x) => x.editable)) {
        const act = pick(["none", "replace", "remove", "insert"]);
        const after = doc.blocks[doc.blocks.indexOf(b) + 1];
        const eolIn = (s: string): string | undefined => /\r\n|\r|\n/.exec(s)?.[0];
        // the line ending of the block itself, else of the gap after it, else the file's first, else LF
        const own = eolIn(text.slice(b.span!.start, b.span!.end)) ?? eolIn(text.slice(b.span!.end, after?.span!.start ?? text.length)) ?? eolIn(text) ?? "\n";
        if (act === "replace") {
          next = next.replace(b.id, "line one\nline two");
          ops.push({ start: b.span!.start, end: b.span!.end, with: "line one\nline two".replace(/\n/g, own) });
        } else if (act === "remove") {
          next = next.replace(b.id, "");
          ops.push({ start: b.span!.start, end: b.span!.end, with: "" });
        } else if (act === "insert") {
          next = next.insert(b.id, "new *block*");
          ops.push({ start: b.span!.end, end: b.span!.end, with: own + own + "new *block*" });
        }
      }
      const r = next.serialize();
      if (!r.ok) continue;
      checked++;
      expect(r.text, JSON.stringify(text)).toBe(spliced(text, ops));
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe("an unclosed code fence keeps all of its text, the newlines at its end included (tree API and insert)", () => {
  const sources = ["```md\nORIGINAL\n\n", "```md\nORIGINAL\n", "```md\nORIGINAL", "```md\nORIGINAL\n\n\n\n", "~~~\nx\n\n\ny\n\n"];
  const code = (doc: EditableMarkdownDocument): Extract<MdBlock, { type: "code" }> => {
    const b = doc.structure("b1")[0];
    if (b?.type !== "code") throw new Error("not code");
    return b;
  };

  it("reads the text of the fence to the end of the file as the value, a final newline ending the last line", () => {
    expect(code(parseMarkdownDocument("```md\nORIGINAL\n\n")).value).toBe("ORIGINAL\n");
    expect(code(parseMarkdownDocument("```md\nORIGINAL\n")).value).toBe("ORIGINAL");
    expect(code(parseMarkdownDocument("```md\nORIGINAL")).value).toBe("ORIGINAL");
    expect(code(parseMarkdownDocument("```md\nORIGINAL\n\n\n\n")).value).toBe("ORIGINAL\n\n\n");
    const doc = parseMarkdownDocument("```md\nORIGINAL\n\n");
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blockSource("b1")).toBe("```md\nORIGINAL\n");
  });

  for (const src of sources) {
    for (const [variant, text] of variants(src)) {
      it(`replaceNodes keeps the fence unclosed and every newline of its text: ${JSON.stringify(src)}, ${variant}`, () => {
        const doc = parseMarkdownDocument(text);
        const node = code(doc);
        const out = written(doc.replaceNodes("b1", [{ ...node, value: node.value.replace(/ORIGINAL|x/, "CHANGED") }]));
        expect(out).toBe(text.replace(/ORIGINAL|x/, "CHANGED"));
        // reading the result back gives the same text with only the word changed
        expect(code(parseMarkdownDocument(out)).value).toBe(node.value.replace(/ORIGINAL|x/, "CHANGED"));
      });

      it(`replace by text keeps them too: ${JSON.stringify(src)}, ${variant}`, () => {
        const doc = parseMarkdownDocument(text);
        expect(written(doc.replace("b1", doc.blockSource("b1").replace(/ORIGINAL|x/, "CHANGED")))).toBe(text.replace(/ORIGINAL|x/, "CHANGED"));
      });
    }

    it(`insert keeps the newlines of an unclosed fence it is given: ${JSON.stringify(src)}`, () => {
      expect(written(parseMarkdownDocument("").insert(null, src))).toBe(src);
      expect(written(parseMarkdownDocument("# T\n").insert("b1", src))).toBe(`# T\n\n${src}\n`);
      const into = parseMarkdownDocument("");
      expect(written(into.insertNodes(null, parseBlocks(src)))).toBe(src);
    });
  }

  it("the exact cases from the review: value changed through the tree, and the fence inserted into an empty file", () => {
    const doc = parseMarkdownDocument("```md\nORIGINAL\n\n");
    const node = code(doc);
    expect(written(doc.replaceNodes("b1", [{ ...node, value: "CHANGED\n" }]))).toBe("```md\nCHANGED\n\n");
    expect(written(parseMarkdownDocument("").insert(null, "```md\nORIGINAL\n\n"))).toBe("```md\nORIGINAL\n\n");
  });

  it("a fence written unclosed that would swallow what follows is refused, not written closed or cut", () => {
    const doc = parseMarkdownDocument("```md\nA\n\n");
    const node = code(doc);
    const r = doc.replaceNodes("b1", [{ ...node, value: "A" }, { type: "paragraph", inlines: [{ type: "text", value: "after" }] }]).serialize();
    expect(r.ok).toBe(false);
  });

  it("in a quote or a list item the fence text stays in it", () => {
    const quote = parseMarkdownDocument("> ```md\n> ORIGINAL\n>\n");
    const q = quote.structure("b1")[0] as Extract<MdBlock, { type: "quote" }>;
    const inner = q.children[0] as Extract<MdBlock, { type: "code" }>;
    expect(inner.unclosed).toBe(true);
    expect(written(quote.replaceNodes("b1", [{ ...q, children: [{ ...inner, value: inner.value.replace("ORIGINAL", "CHANGED") }] }]))).toBe("> ```md\n> CHANGED\n>\n");
    expect(written(quote)).toBe("> ```md\n> ORIGINAL\n>\n");
  });
});
