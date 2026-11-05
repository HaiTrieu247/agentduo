import { describe, expect, it } from "vitest";
import { insertMention, mentionAt, mentionedPaths, mentionText, rankPaths, type PathEntry } from "../../src/inputs/mention-text.js";

const file = (path: string): PathEntry => ({ path, kind: "file" });
const folder = (path: string): PathEntry => ({ path, kind: "folder" });
const paths = (list: PathEntry[]) => list.map((e) => e.path);

describe("mentionAt", () => {
  it("finds the @ word the caret is in, at the start or after a space", () => {
    expect(mentionAt("@")).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionAt("look at @src/co")).toEqual({ start: 8, end: 15, query: "src/co" });
    expect(mentionAt("line one\n@READ")).toEqual({ start: 9, end: 14, query: "READ" });
  });

  it("is not an email address or a word that only contains an @", () => {
    expect(mentionAt("mail me at a@b.com")).toBeNull();
    expect(mentionAt("x@")).toBeNull();
  });

  it("ends at a space: the word before the caret is no longer a mention", () => {
    expect(mentionAt("@src/chat.ts ")).toBeNull();
    expect(mentionAt("@src/chat.ts and")).toBeNull();
  });

  it("covers the rest of the word after the caret", () => {
    expect(mentionAt("see @src/cha.ts now", 11)).toEqual({ start: 4, end: 15, query: "src/ch" });
  });

  it("reads a quoted path, closed or still being typed, without its quotes", () => {
    expect(mentionAt('@"my docs/no')).toEqual({ start: 0, end: 12, query: "my docs/no" });
    expect(mentionAt('see @"my docs/notes.md" too', 14)).toEqual({ start: 4, end: 23, query: "my docs/" });
    expect(mentionAt('@"my docs/notes.md" ')).toBeNull();
  });
});

describe("mentionText and insertMention", () => {
  it("writes a path as is, or quoted when it has a space", () => {
    expect(mentionText(file("src/chat.ts"))).toBe("@src/chat.ts");
    expect(mentionText(file("my docs/a.md"))).toBe('@"my docs/a.md"');
    expect(mentionText(folder("my docs/"), true)).toBe('@"my docs/');
  });

  it("replaces the mention being typed and puts the caret after the space that follows it", () => {
    const text = "explain @cha please";
    const at = mentionAt(text, 12)!;
    expect(insertMention(text, at, file("src/chat.ts"), false)).toEqual({ text: "explain @src/chat.ts please", caret: 21 });
    expect(insertMention("@cha", mentionAt("@cha")!, file("src/chat.ts"), false)).toEqual({ text: "@src/chat.ts ", caret: 13 });
  });

  it("leaves an opened folder without a space, so typing goes on inside it", () => {
    expect(insertMention("@co", mentionAt("@co")!, folder("src/core/"), true)).toEqual({ text: "@src/core/", caret: 10 });
    expect(mentionAt("@src/core/")).toEqual({ start: 0, end: 10, query: "src/core/" });
  });
});

describe("mentionedPaths", () => {
  it("lists each path a text mentions once, in order, without quotes", () => {
    expect(mentionedPaths('read @src/a.ts and @"my docs/b.md", then @src/a.ts again')).toEqual(["src/a.ts", "my docs/b.md"]);
  });

  it("leaves email addresses and a lone @ out", () => {
    expect(mentionedPaths("ask a@b.com about @ nothing")).toEqual([]);
  });
});

describe("rankPaths", () => {
  const entries = [
    folder("src/"), folder("src/core/"), folder("src/ui/"), folder("src/ui/ink/"), folder("test/"),
    file("README.md"), file("package.json"), file("src/chat.ts"), file("src/cli.ts"), file("src/core/config.ts"), file("src/core/git.ts"),
    file("src/core/run-git.ts"), file("src/core/attachments.ts"), file("src/ui/ink/ChatApp.tsx"), file("test/git.test.ts"), file("test/chat.test.ts"),
  ];

  it("shows the workspace's top level for a bare @, folders first", () => {
    expect(paths(rankPaths("", entries))).toEqual(["src/", "test/", "package.json", "README.md"]);
  });

  it("shows a folder's own entries once its path is typed, folders first", () => {
    expect(paths(rankPaths("src/", entries))).toEqual(["src/core/", "src/ui/", "src/chat.ts", "src/cli.ts"]);
    expect(paths(rankPaths("SRC/UI/", entries))).toEqual(["src/ui/ink/"]);
  });

  it("matches letters in order, ignoring case, and leaves out what does not match", () => {
    expect(paths(rankPaths("cfg", entries))).toEqual(["src/core/config.ts"]);
    expect(paths(rankPaths("CHATAPP", entries))).toEqual(["src/ui/ink/ChatApp.tsx"]);
    expect(rankPaths("zzz", entries)).toEqual([]);
  });

  it("ranks a match at the start of a name above one inside a word, and a shorter path first", () => {
    const git = paths(rankPaths("git", entries));
    expect(git.indexOf("src/core/git.ts")).toBeLessThan(git.indexOf("src/core/run-git.ts"));
    expect(paths(rankPaths("chat", entries))[0]).toBe("src/chat.ts");
  });

  it("ranks the path typed so far above loose matches", () => {
    expect(paths(rankPaths("core/att", entries))[0]).toBe("src/core/attachments.ts");
    expect(paths(rankPaths("src/core", entries))[0]).toBe("src/core/");
  });

  it("gives at most `limit` entries", () => {
    expect(rankPaths("s", entries, 3)).toHaveLength(3);
  });
});
