// The composer's files: what the webview reads (FileQueue) and how the view state counts them while a run goes on.
import type { Attachment } from "@agentduo/engine/inputs/attachment-types";
import { initialState, readyAttachments, reduce, sendStops, uploading, type ViewState } from "@agentduo/host/viewState";
import { describe, expect, it } from "vitest";
import { FileQueue, type FileReading } from "../src/uploads.js";

describe("composer's files", () => {
  const stored = (id: string, name = `${id}.png`): Attachment => ({
    id, name, mediaType: "image/png", size: 10, image: { format: "png", width: 1, height: 1 }, path: `conversations/c/attachments/${id}/${name}`,
  });
  const running = (): ViewState => ({ ...initialState("active"), status: "running" });

  /** FileReaders the test finishes by hand, in any order. */
  function readers() {
    const made: Array<FileReading & { finish(text: string): void; fail(): void }> = [];
    const reader = () => {
      const r: FileReading & { result: string | null; finish(text: string): void; fail(): void } = {
        result: null, onload: null, onerror: null,
        readAsDataURL: () => undefined,
        finish(text: string) {
          r.result = `data:application/octet-stream;base64,${Buffer.from(text).toString("base64")}`;
          r.onload?.(undefined as never);
        },
        fail: () => r.onerror?.(undefined as never),
      };
      made.push(r);
      return r;
    };
    return { made, reader };
  }
  const queue = () => {
    const { made, reader } = readers();
    const sent: string[] = [];
    const failed: string[] = [];
    const q = new FileQueue({ reader, send: (f) => sent.push(`${f.key}:${Buffer.from(f.data, "base64").toString()}`), failed: (n) => failed.push(n), changed: () => undefined });
    return { q, made, sent, failed };
  };
  const blob = new Blob(["x"]);

  it("sends a file-only note while a pipeline runs: the send control stops it only when there is nothing to send", () => {
    let s = running();
    expect(sendStops(s, "", 0)).toBe(true);
    expect(sendStops(s, "a note", 0)).toBe(false);
    // Still read by the webview, or attached by the host: Send waits for it, as Enter does; it does not stop the run.
    expect(sendStops(s, "", 1)).toBe(false);
    s = reduce(s, { type: "attachment.uploading", key: "w1", name: "a.png" });
    expect(sendStops(s, "", 0)).toBe(false);
    s = reduce(s, { type: "attachment.ready", key: "w1", attachment: stored("a1", "a.png") });
    expect(sendStops(s, "", 0)).toBe(false);
    expect(readyAttachments(s)).toEqual(["a1"]);
    // A file that could not be attached goes with nothing: the control stops the run again.
    s = reduce(s, { type: "attachment.dismissed", key: "w1" });
    s = reduce(s, { type: "attachment.failed", key: "w2", name: "b.png", error: "too large" });
    expect(sendStops(s, "", 0)).toBe(true);
    expect(sendStops({ ...s, status: "idle" }, "", 0)).toBe(false);
  });

  it("hands read files to the host in the order given, whichever reader finishes first", () => {
    const { q, made, sent } = queue();
    q.add("w1", "one.png", blob);
    q.add("w2", "two.png", blob);
    q.add("w3", "three.png", blob);
    expect(q.waiting.map((f) => f.key)).toEqual(["w1", "w2", "w3"]);
    made[2]!.finish("3");
    made[1]!.finish("2");
    expect(sent).toEqual([]); // the first is still being read
    made[0]!.finish("1");
    expect(sent).toEqual(["w1:1", "w2:2", "w3:3"]);
    // Sent, but not shown by the host yet: the composer still waits for all three.
    expect(q.size).toBe(3);
    q.settle(new Set(["w1", "w3"]));
    expect(q.waiting).toEqual([{ key: "w2", name: "two.png", sent: true }]);
  });

  it("holds a message back from the paste until the host shows the file, so it cannot go without it", () => {
    const { q, made, sent } = queue();
    let s = running();
    const waits = () => uploading(s) || q.size > 0;
    q.add("w1", "shot.png", blob);
    expect(waits()).toBe(true); // still being read
    made[0]!.finish("png");
    expect(sent).toEqual(["w1:png"]);
    expect(waits()).toBe(true); // on its way to the host
    s = reduce(s, { type: "attachment.uploading", key: "w1", name: "shot.png" });
    q.settle(new Set(s.attachments.map((c) => c.key)));
    expect(q.size).toBe(0);
    expect(waits()).toBe(true); // the host attaches it
    s = reduce(s, { type: "attachment.ready", key: "w1", attachment: stored("a1", "shot.png") });
    expect(waits()).toBe(false);
    expect(readyAttachments(s)).toEqual(["a1"]);
  });

  it("lets later files go when one is removed or cannot be read, and says which host file to let go of", () => {
    const { q, made, sent, failed } = queue();
    q.add("w1", "one.png", blob);
    q.add("w2", "two.png", blob);
    q.add("w3", "three.png", blob);
    q.add("w4", "four.png", blob);
    made[1]!.finish("2");
    made[2]!.finish("3");
    expect(q.remove("w1")).toBe(false); // never sent: the host has nothing to let go of
    expect(sent).toEqual(["w2:2", "w3:3"]);
    expect(q.remove("w2")).toBe(true); // sent: the host lets go of it too
    made[0]!.finish("1"); // removed meanwhile: not sent
    made[3]!.fail();
    expect(failed).toEqual(["four.png"]);
    expect(sent).toEqual(["w2:2", "w3:3"]);
    expect(q.waiting.map((f) => f.key)).toEqual(["w3"]);
  });

  it("lets the page be reloaded only once every file read here is with the host, then takes no more", () => {
    const { q, made, sent } = queue();
    let released = 0;
    q.add("w1", "shot.png", blob);
    q.add("w2", "notes.pdf", blob);
    made[0]!.finish("png");
    q.settle(new Set(["w1"])); // the image is with the host (and its URI is what makes the page reload)
    q.release(() => released++);
    expect(released).toBe(0); // the PDF is still being read: a reload now would lose it
    expect(q.add("w3", "more.txt", blob)).toBe(true); // given meanwhile: waited for as well
    made[1]!.finish("pdf");
    made[2]!.finish("txt");
    expect(sent).toEqual(["w1:png", "w2:pdf", "w3:txt"]);
    expect(released).toBe(0); // sent, but not shown by the host yet
    q.settle(new Set(["w1", "w2", "w3"]));
    expect(released).toBe(1);
    // The page may go any moment now: a file given now is refused (and said so), never silently lost.
    expect(q.add("w4", "late.png", blob)).toBe(false);
    expect(q.size).toBe(0);
    expect(made).toHaveLength(3);
  });

  it("is ready to reload at once when it holds nothing, or once its last file is removed or cannot be read", () => {
    const empty = queue();
    let n = 0;
    empty.q.release(() => n++);
    expect(n).toBe(1);
    const { q, made } = queue();
    let removed = 0;
    q.add("w1", "a.png", blob);
    q.add("w2", "b.png", blob);
    q.release(() => removed++);
    q.remove("w1");
    expect(removed).toBe(0);
    made[1]!.fail();
    expect(removed).toBe(1);
  });
});
