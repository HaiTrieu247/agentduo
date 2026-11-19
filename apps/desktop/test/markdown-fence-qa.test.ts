// QA owns this file (R19). AC2/AC4 and T2's explicit safe-fence requirement:
// text typed into code remains code even when it contains the old Markdown fence.
import { describe, expect, it } from "vitest";
import { parseMarkdownDocument, type EditableMarkdownDocument, type MdBlock } from "../src/shared/markdown-document.js";

function saved(doc: EditableMarkdownDocument): string {
  const result = doc.serialize();
  expect(result, "choose a safe delimiter for valid code payload, then allow Save").toMatchObject({ ok: true });
  if (!result.ok) throw new Error(JSON.stringify(result.blocks));
  return result.text;
}

function code(doc: EditableMarkdownDocument, id: string): Extract<MdBlock, { type: "code" }> {
  const node = doc.structure(id)[0]!;
  expect(node.type).toBe("code");
  if (node.type !== "code") throw new Error("Expected a code block");
  return node;
}

describe("T2 QA · safe delimiters for edited unclosed code fences", () => {
  it.each([
    ["backticks equal to opener", "```md\nORIGINAL\n\n", "first\n```\nlast"],
    ["backticks longer than opener", "```md\nORIGINAL\n\n", "first\n`````\nlast"],
    ["tildes equal to opener", "~~~text\nORIGINAL\n\n", "first\n~~~\nlast"],
    ["CRLF tilde document", "~~~text\r\nORIGINAL\r\n\r\n", "first\n~~~\nlast"],
    ["shorter backticks remain payload", "````md\nORIGINAL\n\n", "first\n```\nlast"],
    ["closed fence control", "```md\nORIGINAL\n```\n", "first\n```\nlast"],
  ])("saves a code edit containing %s", (_name, source, value) => {
    const doc = parseMarkdownDocument(source);
    const original = code(doc, "b1");
    const draft = doc.replaceNodes("b1", [{ ...original, value }]);
    const out = saved(draft);
    const reopened = parseMarkdownDocument(out);
    expect(reopened.blocks).toHaveLength(1);
    expect(code(reopened, "b1")).toMatchObject({ value, info: original.info });
    expect(saved(doc)).toBe(source);
  });

  it.each(["```", "~~~"])("can insert an unclosed %s code tree whose payload contains that delimiter", (fence) => {
    const template = parseMarkdownDocument(`${fence}text\nORIGINAL`);
    const original = code(template, "b1");
    const value = `first\n${fence}\nlast`;
    const draft = parseMarkdownDocument("").insertNodes(null, [{ ...original, value }]);
    const out = saved(draft);
    const reopened = parseMarkdownDocument(out);
    expect(reopened.blocks).toHaveLength(1);
    expect(code(reopened, "b1")).toMatchObject({ value, info: "text" });
  });

  it.each(["```md\nORIGINAL", "```md\nORIGINAL\n\n", "~~~text\r\nORIGINAL\r\n\r\n"])(
    "keeps unclosed-fence source intact through insertion and a tree edit: %j", (source) => {
      const inserted = parseMarkdownDocument("").insert(null, source);
      // An empty target has the default LF convention; inserted text follows the target's EOL.
      const expected = source.replace(/\r\n|\r/g, "\n");
      expect(saved(inserted)).toBe(expected);
      const reopened = parseMarkdownDocument(saved(inserted));
      const original = code(reopened, "b1");
      const draft = reopened.replaceNodes("b1", [{ ...original, value: original.value.replace("ORIGINAL", "CHANGED") }]);
      expect(saved(draft)).toBe(expected.replace("ORIGINAL", "CHANGED"));
    },
  );
});

describe("T2 QA · AC5/R34: a successful save retains the whole supplied code payload", () => {
  it.each([
    ["LF file without final newline", "```md\nORIGINAL", "CHANGED\n"],
    ["two payload newlines", "```md\nORIGINAL", "CHANGED\n\n"],
    ["CRLF file without final newline", "```md\r\nORIGINAL", "CHANGED\n"],
    ["BOM and tilde fence", "\ufeff~~~text\nORIGINAL", "CHANGED\n"],
  ])("never reports success after dropping payload bytes: %s", (_name, source, value) => {
    const doc = parseMarkdownDocument(source);
    const original = code(doc, "b1");
    const draft = doc.replaceNodes("b1", [{ ...original, value }]);
    const result = draft.serialize();
    if (result.ok) {
      const reopened = parseMarkdownDocument(result.text);
      expect(reopened.blocks).toHaveLength(1);
      expect(code(reopened, "b1").value, "file-ending context must not change the editor's payload").toBe(value);
    } else {
      expect(result).not.toHaveProperty("text");
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks.every((b) => b.message.trim().length > 0)).toBe(true);
    }
    expect(saved(doc)).toBe(source);
  });

  it.each(["CHANGED\n", "\n"])("inserting a code tree cannot silently drop its terminal newline: %j", (value) => {
    const template = parseMarkdownDocument("```md\nORIGINAL");
    const draft = parseMarkdownDocument("").insertNodes(null, [{ ...code(template, "b1"), value }]);
    const result = draft.serialize();
    if (result.ok) {
      const reopened = parseMarkdownDocument(result.text);
      expect(reopened.blocks).toHaveLength(1);
      expect(code(reopened, "b1").value).toBe(value);
    } else {
      expect(result).not.toHaveProperty("text");
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks.every((b) => b.message.trim().length > 0)).toBe(true);
    }
  });
});
