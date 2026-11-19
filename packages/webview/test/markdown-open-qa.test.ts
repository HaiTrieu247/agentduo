// QA-owned regression cases for T4's link parser changes. Do not use desktop helpers here: this is the chat parser
// shared with VS Code, and both the displayed destination and the link's ordinal are externally visible contracts.
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type Block, type Inline } from "../src/markdown.js";

function links(blocks: Block[]): Array<Extract<Inline, { type: "link" }>> {
  const found: Array<Extract<Inline, { type: "link" }>> = [];
  const inline = (nodes: Inline[]): void => {
    for (const node of nodes) {
      if (node.type === "link") found.push(node);
      if ("children" in node) inline(node.children);
    }
  };
  const visit = (block: Block): void => {
    if (block.type === "paragraph" || block.type === "heading") inline(block.children);
    if (block.type === "list") block.items.forEach((item) => item.forEach(visit));
    if (block.type === "quote") block.children.forEach(visit);
    if (block.type === "table") { block.head.forEach(inline); block.rows.forEach((row) => row.forEach(inline)); }
  };
  blocks.forEach(visit);
  return found;
}

describe("T4 independent QA — displayed Markdown link targets (AC1; R28/R29/R37)", () => {
  it.each([
    ["[file](<team worktree/ghi chú (1).md>)", "team worktree/ghi chú (1).md"],
    ["[file](docs/nested(one(two)).md)", "docs/nested(one(two)).md"],
    ['[file](<docs/a b(1).md> "title (not a path)")', "docs/a b(1).md"],
    ["[file](file:///repo/ghi%20ch%C3%BA.md#L12)", "file:///repo/ghi%20ch%C3%BA.md#L12"],
    ["[file](<C:\\Team Worktree\\notes (1).md>)", "C:\\Team Worktree\\notes (1).md"],
    ["[file](docs/a\\(one\\).md)", "docs/a(one).md"],
    ["[file](docs/100%2520.md)", "docs/100%2520.md"],
  ])("keeps exactly the destination of %s, without title or early percent decoding", (markdown, href) => {
    const found = parseInline(markdown).filter((node) => node.type === "link");
    expect(found).toEqual([{ type: "link", href, children: [{ type: "text", text: "file" }] }]);
  });

  it("preserves global link order through formatting, quote, list and table; code is never a link", () => {
    const text = [
      "# [heading](head.md)", "", "[web](https://example.test) **[bold](<bold path.md>)**", "",
      "> [quote](quote.md)", "", "- [first](list(1).md)", "- *[second](list2.md)*", "",
      "| [head](table-head.md) | Another |", "| --- | --- |", "| [cell](<cell space.md>) | `x` |", "",
      "```md", "[not clickable](inside-fence.md)", "```", "", "`[also not clickable](inline.md)`", "",
      "[last](last.md)",
    ].join("\n");
    expect(links(parseMarkdown(text)).map((link) => link.href)).toEqual([
      "head.md", "https://example.test", "bold path.md", "quote.md", "list(1).md", "list2.md", "table-head.md", "cell space.md", "last.md",
    ]);
  });

  it.each(["report\\(part).md", "dir\\(part)\\file.md"])("marks an ambiguous bare destination %s so no caller can guess a target", (target) => {
    const found = parseInline(`[file](${target})`).find((node) => node.type === "link");
    expect(found).toMatchObject({ type: "link", ambiguous: true });
    // The explicit angle form is a distinct, unambiguous request; it retains literal backslashes.
    const explicit = parseInline(`[file](<${target}>)`).find((node) => node.type === "link");
    expect(explicit).toEqual({ type: "link", href: target, children: [{ type: "text", text: "file" }] });
  });

  it.each(["[file](<>)", "[file](<broken path.md)", "[file](<line\nbreak.md>)", "[file](unfinished.md"])("does not invent a destination for malformed input %j", (text) => {
    expect(parseInline(text).some((node) => node.type === "link")).toBe(false);
  });
});
