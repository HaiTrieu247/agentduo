import { describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "../extensions/vscode/src/conversationPanel.js";
import type { HostMessage, WebviewMessage } from "../extensions/vscode/src/protocol.js";
import { initialState, readyAttachments, reduce, shownImages, type ViewState } from "../extensions/vscode/webview/state.js";
import { FileQueue, type FileReading } from "../extensions/vscode/webview/uploads.js";
import type { Attachment } from "../src/core/attachment-types.js";

// The panel needs only Uri from VS Code (vi.mock is hoisted above the imports); a WebviewPanel is faked below.
vi.mock("vscode", () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/") }),
    file: (fsPath: string) => ({ fsPath }),
  },
}));

type Options = { localResourceRoots?: Array<{ fsPath: string }> };
const ROOT = "/repo/.agentduo/runs/conversations/c1/attachments";

/** A tab's WebviewPanel: every options change is a reload (as in VS Code); what the host posts goes to `page`. */
function fakePanel() {
  const heard: Array<(m: unknown) => void> = [];
  const viewState: Array<() => void> = [];
  const reloads: Options[] = [];
  let page: (m: HostMessage) => void = () => undefined;
  const panel = {
    active: true, visible: true, title: "agentduo", viewColumn: 1, iconPath: undefined as unknown,
    webview: {
      cspSource: "vscode-webview:", html: "",
      get options(): Options {
        return reloads.at(-1) ?? {};
      },
      set options(o: Options) {
        reloads.push(o);
      },
      asWebviewUri: (u: { fsPath: string }) => ({ toString: () => `webview:${u.fsPath}` }),
      onDidReceiveMessage: (f: (m: unknown) => void) => (heard.push(f), { dispose: () => undefined }),
      postMessage: async (m: HostMessage) => (page(m), true),
    },
    onDidChangeViewState: (f: () => void) => (viewState.push(f), { dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
    reveal: () => undefined,
  };
  return {
    panel,
    /** The options set after the first page loaded: each reloaded it. */
    reloads: () => reloads.length - 1,
    roots: () => (reloads.at(-1)?.localResourceRoots ?? []).map((u) => u.fsPath),
    say: (m: WebviewMessage) => heard.forEach((f) => f(m)),
    onPost: (f: (m: HostMessage) => void) => (page = f),
    hide: () => {
      panel.visible = panel.active = false;
      viewState.forEach((f) => f());
    },
  };
}

function setup(known: string[] = []) {
  const fake = fakePanel();
  const heard: WebviewMessage[] = [];
  const host = { fromWebview: (_: string, m: WebviewMessage) => void heard.push(m), hidden: () => undefined, focused: () => undefined, closed: () => undefined, log: () => undefined };
  const p = new ConversationPanel("c1", fake.panel as never, { fsPath: "/ext" } as never, host, known);
  return { ...fake, p, heard };
}

/** FileReaders finished by hand. */
function readers() {
  const made: Array<FileReading & { finish(text: string): void }> = [];
  const reader = () => {
    const r: FileReading & { result: string | null; finish(text: string): void } = {
      result: null, onload: null, onerror: null, readAsDataURL: () => undefined,
      finish(text: string) {
        r.result = `data:application/octet-stream;base64,${Buffer.from(text).toString("base64")}`;
        r.onload?.(undefined as never);
      },
    };
    made.push(r);
    return r;
  };
  return { made, reader };
}

const stored = (id: string, name: string, image: boolean): Attachment => ({
  id, name, mediaType: image ? "image/png" : "application/pdf", size: 3, image: image ? { format: "png", width: 1, height: 1 } : null,
  path: `conversations/c1/attachments/${id}/${name}`,
});

describe("a conversation tab's resource roots", () => {
  it("reloads for its first image only once the files its page is still reading are with the host, and sends them all", () => {
    const t = setup();
    // The page: its composer's queue, which shows what the host shows (settle) and answers the host's prepareReload.
    const { made, reader } = readers();
    let pageUp = true;
    const q = new FileQueue({ reader, send: (f) => t.say({ type: "upload", ...f }), failed: () => undefined, changed: () => undefined });
    t.onPost((m) => {
      if (pageUp && m.type === "prepareReload") q.release(() => t.say({ type: "readyToReload" }));
    });
    // The host: a file's chip comes as its upload arrives; a stored image makes it grant the tab its root.
    let s: ViewState = initialState("dormant");
    const show = () => q.settle(new Set(s.attachments.map((c) => c.key)));
    const store = (key: string, a: Attachment) => {
      s = reduce(s, { type: "attachment.ready", key, attachment: a });
      if (shownImages(s).length) t.p.allow(ROOT);
    };
    t.say({ type: "ready" });
    const uploads = () => t.heard.flatMap((m) => (m.type === "upload" ? [m.key] : []));

    q.add("w1", "shot.png", new Blob(["png"]));
    q.add("w2", "notes.pdf", new Blob(["pdf"]));
    made[0]!.finish("png");
    expect(uploads()).toEqual(["w1"]);
    s = reduce(s, { type: "attachment.uploading", key: "w1", name: "shot.png" });
    show();
    store("w1", stored("a1", "shot.png", true));
    // The image is stored while the PDF is still being read: the page is asked, and is not reloaded yet.
    expect(t.reloads()).toBe(0);
    expect(t.p.allow(ROOT)).toBe(false);

    made[1]!.finish("pdf");
    expect(uploads()).toEqual(["w1", "w2"]);
    expect(t.reloads()).toBe(0); // sent, not shown yet
    s = reduce(s, { type: "attachment.uploading", key: "w2", name: "notes.pdf" });
    show();
    // Every file is with the host now: the page said so, and the options change (a reload).
    expect(t.reloads()).toBe(1);
    expect(t.roots()).toEqual(["/ext/dist/webview", ROOT]);
    pageUp = false;

    store("w2", stored("a2", "notes.pdf", false));
    expect(readyAttachments(s)).toEqual(["a1", "a2"]);
    // The new page loads: the root is its own now, no further reload.
    t.say({ type: "ready" });
    expect(t.p.allow(ROOT)).toBe(true);
    expect(t.reloads()).toBe(1);
  });

  it("asks the page once, ignores an answer it did not ask for, and reloads at once when no page is up", () => {
    const t = setup();
    const posted: HostMessage[] = [];
    t.onPost((m) => void posted.push(m));
    // The first page is still loading: it holds no file, so the root is applied at once.
    expect(t.p.allow(ROOT)).toBe(false);
    expect(t.reloads()).toBe(1);
    expect(posted).toEqual([]);
    expect(t.p.allow(ROOT)).toBe(true);

    t.say({ type: "ready" });
    const other = "/repo/elsewhere/conversations/c1/attachments";
    t.p.allow(other);
    t.p.allow(other);
    expect(posted.filter((m) => m.type === "prepareReload")).toHaveLength(1);
    expect(t.reloads()).toBe(1);
    // Hidden, the page is gone (VS Code recreates it when shown): nothing to wait for.
    t.hide();
    expect(t.reloads()).toBe(2);
    expect(t.roots()).toEqual(["/ext/dist/webview", ROOT, other]);
    t.say({ type: "readyToReload" }); // a late answer of the page that was asked
    expect(t.reloads()).toBe(2);
  });

  it("starts with the roots the host knows already: no reload for their images", () => {
    const t = setup([ROOT]);
    t.say({ type: "ready" });
    expect(t.p.allow(ROOT)).toBe(true);
    expect(t.reloads()).toBe(0);
    expect(t.roots()).toEqual(["/ext/dist/webview", ROOT]);
  });
});
