// The ids main grants to the links of a conversation's chat (main/documents.ts `syncLinks`): the same numbering the page
// draws, nothing about the target sent to the renderer, and the revocation of what is gone.
import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@agentduo/host/viewState";
import { DocumentService } from "../src/main/documents.js";
import type { DesktopEvent } from "../src/shared/protocol.js";
import { parseInline } from "@agentduo/webview/markdown";

const P = "0123456789abcdef";
const C = "20261031-120000-tab-abcd1234";
type Links = Extract<DesktopEvent, { type: "documentLinks" }>;

const make = () => {
  const events: Links[] = [];
  const s = new DocumentService({ post: (e) => e.type === "documentLinks" && events.push(e) });
  return { s, events };
};
const pm = (id: string, text: string) => ({ id, kind: "pm", text }) as TimelineItem;
const answer = (id: string, text: string) => ({ id, kind: "answer", turn: { status: "success", answer: text } }) as unknown as TimelineItem;
const user = (id: string, text: string) => ({ id, kind: "user", text }) as TimelineItem;

describe("granting ids to the chat's links", () => {
  it("grants only links to files that open, numbered among all the links of the text, never sending the target", () => {
    const { s, events } = make();
    s.syncLinks(P, C, 1, [pm("a", "[web](https://x.test) [doc](docs/a.md) [code](src/x.ts) [other](<my notes/b.md#h>)")], true);
    const ev = events[0]!;
    expect(ev.links.map((l) => [l.itemId, l.part, l.ordinal])).toEqual([["a", "text", 1], ["a", "text", 3]]);
    expect(JSON.stringify(ev)).not.toContain("docs/a.md");
    expect(JSON.stringify(ev)).not.toContain("notes");
    expect(ev.links[0]!.linkId).toMatch(/^k\d+$/);
  });

  it("reads the PM's text, an agent's answer, and not the user's own words or code", () => {
    const { s, events } = make();
    s.syncLinks(P, C, 1, [user("u", "[mine](a.md)"), pm("p", "see [a](a.md) and `[no](b.md)`"), answer("r", "[c](c.md)")], true);
    expect(events[0]!.links.map((l) => [l.itemId, l.part, l.ordinal])).toEqual([["p", "text", 0], ["r", "answer", 0]]);
  });

  it("keeps an id while the chat grows, tells only the new ones, and revokes what changed or went", () => {
    const { s, events } = make();
    s.syncLinks(P, C, 1, [pm("a", "[x](a.md)")], true);
    const first = events[0]!.links[0]!.linkId;
    s.syncLinks(P, C, 1, [pm("a", "[x](a.md)"), pm("b", "[y](b.md)")], false);
    expect(events[1]!.links).toHaveLength(1);
    expect(events[1]!.revoked).toEqual([]);
    // Nothing new: no event.
    s.syncLinks(P, C, 1, [pm("a", "[x](a.md)"), pm("b", "[y](b.md)")], false);
    expect(events).toHaveLength(2);
    // The text of `a` now points elsewhere: the old id is revoked, a new one granted.
    s.syncLinks(P, C, 1, [pm("a", "[x](c.md)"), pm("b", "[y](b.md)")], false);
    expect(events[2]!.revoked).toEqual([first]);
    expect(events[2]!.links[0]!.linkId).not.toBe(first);
    // A snapshot tells every live id again.
    s.syncLinks(P, C, 1, [pm("b", "[y](b.md)")], true);
    expect(events[3]!.links).toHaveLength(1);
    expect(events[3]!.revoked).toHaveLength(1);
  });

  it("a new view revokes the ids of the earlier one", () => {
    const { s, events } = make();
    s.syncLinks(P, C, 1, [pm("a", "[x](a.md)")], true);
    const old = events[0]!.links[0]!.linkId;
    s.syncLinks(P, C, 2, [pm("a", "[x](a.md)")], true);
    expect(events[1]!.revoked).toEqual([old]);
    expect(events[1]!.links[0]!.linkId).not.toBe(old);
  });

  it("two conversations never share ids, and revoking a project drops all its conversations", () => {
    const { s } = make();
    s.syncLinks(P, "c1", 1, [pm("a", "[x](a.md)")], true);
    s.syncLinks(P, "c2", 1, [pm("a", "[x](a.md)")], true);
    s.syncLinks("ffffffffffffffff", "c3", 1, [pm("a", "[x](a.md)")], true);
    expect(s.links.size).toBe(3);
    expect(s.revokeProject(P)).toHaveLength(2);
    expect(s.links.size).toBe(1);
  });

  it("opening through the id of another conversation finds nothing", async () => {
    const { s, events } = make();
    s.syncLinks(P, "c1", 1, [pm("a", "[x](/nowhere/a.md)")], true);
    const id = events[0]!.links[0]!.linkId;
    const r = await s.open({ projectId: P, conversationId: "c2", view: 1, linkId: id, workspace: null });
    expect(r.ok ? "ok" : r.error.code).toBe("link-stale");
  });
});

// Q1 (T1's parser, fixed in T3 attempt 3 with the PM's approval): the chat's parser is the one place that reads a link's
// target, for the page and for main alike (`documentLinkSites`), so an escape is read there and nowhere else.
describe("a bare target with escaped parentheses (R29)", () => {
  const href = (src: string) => (parseInline(src).find((n) => n.type === "link") as { href: string } | undefined)?.href;

  it("reads `\\(` and `\\)` as the parentheses of the name, in pairs and alone, with a title and text after the link", () => {
    expect(href("[open](plan\\(1\\).md)")).toBe("plan(1).md");
    expect(href("[open](plan\\(1.md)")).toBe("plan(1.md");
    expect(href("[open](plan\\).md)")).toBe("plan).md");
    expect(href("[open](docs/a\\(1\\)\\(2\\).md:4)")).toBe("docs/a(1)(2).md:4");
    expect(href('[open](plan\\(1\\).md "a title")')).toBe("plan(1).md");
    expect(parseInline("[open](plan\\(1\\).md) (note)")).toEqual([
      { type: "link", href: "plan(1).md", children: [{ type: "text", text: "open" }] },
      { type: "text", text: " (note)" },
    ]);
    expect(href("[open](plan(1).md)")).toBe("plan(1).md");
  });

  it("keeps a Windows path as written: a folder in parentheses, a drive, a UNC share, the <…> form", () => {
    expect(href("[a](dir\\(x)\\a.md)")).toBe("dir\\(x)\\a.md");
    expect(href("[a](dir\\(x)\\(y)\\a.md)")).toBe("dir\\(x)\\(y)\\a.md");
    expect(href("[a](C:\\dir\\(x)\\a.md)")).toBe("C:\\dir\\(x)\\a.md");
    expect(href("[a](C:\\dir\\(x\\)\\a.md)")).toBe("C:\\dir\\(x\\)\\a.md");
    expect(href("[a](\\\\server\\share\\(x)\\a.md)")).toBe("\\\\server\\share\\(x)\\a.md");
    expect(href("[a](<C:\\My Docs\\(x)\\a.md>)")).toBe("C:\\My Docs\\(x)\\a.md");
    expect(href("[a](<plan\\(1\\).md>)")).toBe("plan\\(1\\).md");
    expect(href("[a](x\\y.md)")).toBe("x\\y.md");
  });

  it("main grants the link with the same target the page reads, so the ids stay in step", () => {
    const { s, events } = make();
    s.syncLinks(P, C, 1, [pm("a", "[w](https://x.test) [open](plan\\(1\\).md) [b](dir\\(x)\\b.md)")], true);
    expect(events[0]!.links.map((l) => l.ordinal)).toEqual([1, 2]);
  });
});
