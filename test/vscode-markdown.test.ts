import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type Inline } from "../extensions/vscode/webview/markdown.js";

const text = (t: string): Inline => ({ type: "text", text: t });

describe("markdown blocks", () => {
  it("splits paragraphs on blank lines and keeps single line breaks", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", children: [text("one"), { type: "break" }, text("two")] },
      { type: "paragraph", children: [text("three")] },
    ]);
  });

  it("reads ATX headings", () => {
    expect(parseMarkdown("# Title\n### Sub ##")).toEqual([
      { type: "heading", level: 1, children: [text("Title")] },
      { type: "heading", level: 3, children: [text("Sub")] },
    ]);
    expect(parseMarkdown("#no space")).toEqual([{ type: "paragraph", children: [text("#no space")] }]);
  });

  it("keeps fenced code verbatim, also an unclosed fence", () => {
    expect(parseMarkdown("```ts\nconst a = **1**;\n\n<b>x</b>\n```\nafter")).toEqual([
      { type: "code", lang: "ts", text: "const a = **1**;\n\n<b>x</b>" },
      { type: "paragraph", children: [text("after")] },
    ]);
    expect(parseMarkdown("~~~~\na\n~~~\nb")).toEqual([{ type: "code", lang: "", text: "a\n~~~\nb" }]);
  });

  it("reads bullet and ordered lists, with their start and nesting", () => {
    expect(parseMarkdown("- a\n- b\n  - c\n- d")).toEqual([{
      type: "list", ordered: false, start: 1, items: [
        [{ type: "paragraph", children: [text("a")] }],
        [{ type: "paragraph", children: [text("b")] }, { type: "list", ordered: false, start: 1, items: [[{ type: "paragraph", children: [text("c")] }]] }],
        [{ type: "paragraph", children: [text("d")] }],
      ],
    }]);
    expect(parseMarkdown("3. x\n4. y")).toEqual([{
      type: "list", ordered: true, start: 3, items: [[{ type: "paragraph", children: [text("x")] }], [{ type: "paragraph", children: [text("y")] }]],
    }]);
  });

  it("keeps an item's continuation lines and later paragraphs in the item", () => {
    expect(parseMarkdown("1. first\n   more\n\n   second para\n2. next")).toEqual([{
      type: "list", ordered: true, start: 1, items: [
        [{ type: "paragraph", children: [text("first"), { type: "break" }, text("more")] }, { type: "paragraph", children: [text("second para")] }],
        [{ type: "paragraph", children: [text("next")] }],
      ],
    }]);
  });

  it("ends a list at a blank line followed by unindented text", () => {
    expect(parseMarkdown("- a\n\nafter")).toEqual([
      { type: "list", ordered: false, start: 1, items: [[{ type: "paragraph", children: [text("a")] }]] },
      { type: "paragraph", children: [text("after")] },
    ]);
  });

  it("reads block quotes and rules", () => {
    expect(parseMarkdown("> quoted\n> **text**\n\n---")).toEqual([
      { type: "quote", children: [{ type: "paragraph", children: [text("quoted"), { type: "break" }, { type: "strong", children: [text("text")] }] }] },
      { type: "rule" },
    ]);
  });

  it("reads tables with their alignment, escaped pipes and short rows", () => {
    expect(parseMarkdown("| Name | Size |\n|:-----|-----:|\n| `a\\|b` | 3 |\n| c |\n\nend")).toEqual([
      {
        type: "table", align: ["left", "right"],
        head: [[text("Name")], [text("Size")]],
        rows: [[[{ type: "code", text: "a|b" }], [text("3")]], [[text("c")], []]],
      },
      { type: "paragraph", children: [text("end")] },
    ]);
    // Without a delimiter row it is just text.
    expect(parseMarkdown("a | b\nc | d")[0]!.type).toBe("paragraph");
  });

  it("leaves HTML as text", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([{ type: "paragraph", children: [text("<script>alert(1)</script>")] }]);
  });
});

describe("markdown inline", () => {
  it("reads code spans, strong, emphasis and strikethrough", () => {
    expect(parseInline("run `npm test` **now** and *then* ~~never~~")).toEqual([
      text("run "), { type: "code", text: "npm test" }, text(" "), { type: "strong", children: [text("now")] }, text(" and "),
      { type: "em", children: [text("then")] }, text(" "), { type: "del", children: [text("never")] },
    ]);
  });

  it("nests emphasis inside strong", () => {
    expect(parseInline("**a *b* c**")).toEqual([{ type: "strong", children: [text("a "), { type: "em", children: [text("b")] }, text(" c")] }]);
  });

  it("does not emphasise inside words with underscores, nor across spaces", () => {
    expect(parseInline("snake_case_name and 2 * 3 * 4")).toEqual([text("snake_case_name and 2 * 3 * 4")]);
    expect(parseInline("_yes_")).toEqual([{ type: "em", children: [text("yes")] }]);
  });

  it("reads links, keeping the target as data", () => {
    expect(parseInline("see [the docs](docs/README.md) now")).toEqual([
      text("see "), { type: "link", href: "docs/README.md", children: [text("the docs")] }, text(" now"),
    ]);
    expect(parseInline("[not a link] (x)")).toEqual([text("[not a link] (x)")]);
  });

  it("honours backslash escapes and longer backtick runs", () => {
    expect(parseInline("\\*not em\\* ``a ` b``")).toEqual([text("*not em* "), { type: "code", text: "a ` b" }]);
  });

  it("keeps unmatched delimiters as text", () => {
    expect(parseInline("a ** b `c")).toEqual([text("a ** b `c")]);
  });

  it("stays fast on many unmatched delimiters", () => {
    const start = Date.now();
    parseInline("*a ".repeat(20_000) + "`".repeat(5_000) + "[".repeat(5_000));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
