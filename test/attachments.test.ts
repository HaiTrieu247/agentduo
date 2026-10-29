import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, attachmentDetail, base64Size, selectNative, type Attachment } from "../src/core/attachment-types.js";
import { AttachmentError, attachmentFile, AttachmentStore, existingAttachmentFile, imageInfo, mediaTypeOf, safeFileName } from "../src/core/attachments.js";
import { Conversation } from "../src/core/conversation.js";
import { png } from "./helpers/images.js";
import { tempDir } from "./helpers/tmp.js";

const gif = (w: number, h: number) => {
  const b = Buffer.from("GIF89a\0\0\0\0\0\0\0", "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};
const jpeg = (w: number, h: number) => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
]);
const webpX = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};

const image = (format: NonNullable<Attachment["image"]>["format"], width: number, height: number, size: number, id = `${format}-${width}x${height}-${size}`): Attachment =>
  ({ id, name: `${id}.${format}`, mediaType: `image/${format}`, size, image: { format, width, height }, path: `x/${id}` });

let t: { path: string; cleanup(): void };
let runsDir: string;
let store: AttachmentStore;
beforeEach(() => {
  t = tempDir();
  runsDir = join(t.path, "runs");
  store = new AttachmentStore(runsDir, join(runsDir, "conversations", "c1"));
});
afterEach(() => t.cleanup());

describe("image headers", () => {
  it("read the format and size of PNG, GIF, JPEG and WebP", () => {
    expect(imageInfo(png(64, 32))).toEqual({ format: "png", width: 64, height: 32 });
    expect(imageInfo(gif(10, 7))).toEqual({ format: "gif", width: 10, height: 7 });
    expect(imageInfo(jpeg(1280, 720))).toEqual({ format: "jpeg", width: 1280, height: 720 });
    expect(imageInfo(webpX(4000, 3000))).toEqual({ format: "webp", width: 4000, height: 3000 });
  });

  it("give nothing for a header cut short, a size of zero, or another kind of file", () => {
    expect(imageInfo(png(64, 32).subarray(0, 20))).toBeNull();
    expect(imageInfo(jpeg(1280, 720).subarray(0, 24))).toBeNull();
    expect(imageInfo(gif(0, 7))).toBeNull();
    expect(imageInfo(webpX(4, 4).subarray(0, 26))).toBeNull();
    expect(imageInfo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(imageInfo(Buffer.alloc(0))).toBeNull();
  });

  it("tell media types by content first, then by name; unknown text is text/plain", () => {
    expect(mediaTypeOf("photo.txt", png(2, 2))).toBe("image/png");
    expect(mediaTypeOf("doc", Buffer.from("%PDF-1.4\n"))).toBe("application/pdf");
    expect(mediaTypeOf("a.ts", Buffer.from("export const x = 1;\n"))).toBe("text/x-typescript");
    expect(mediaTypeOf("Makefile", Buffer.from("all:\n\techo hi\n"))).toBe("text/plain");
    expect(mediaTypeOf("vn.txt", Buffer.from("Tiếng Việt có dấu ".repeat(500)).subarray(0, 8191))).toBe("text/plain");
    expect(mediaTypeOf("blob", Buffer.from([0, 1, 2, 255]))).toBe("application/octet-stream");
    expect(mediaTypeOf("logo.svg", Buffer.from("<svg/>"))).toBe("image/svg+xml");
  });
});

describe("AttachmentStore", () => {
  it("copies the bytes as they are, under an id of its own, referenced from the runs directory", () => {
    const src = join(t.path, "Ảnh chụp màn hình.png");
    writeFileSync(src, png(64, 32));
    const a = store.importFile(src);
    expect(a).toMatchObject({ name: "Ảnh chụp màn hình.png", mediaType: "image/png", size: readFileSync(src).length, image: { format: "png", width: 64, height: 32 } });
    expect(a.path).toBe(`conversations/c1/attachments/${a.id}/Ảnh chụp màn hình.png`);
    expect(readFileSync(existingAttachmentFile(runsDir, a))).toEqual(readFileSync(src));
    const b = store.importBytes("notes.md", Buffer.from("# hi\n"));
    expect(b.id).not.toBe(a.id);
    expect(b).toMatchObject({ mediaType: "text/markdown", image: null, size: 5 });
    expect(attachmentDetail(a)).toBe(`PNG 64×32, ${a.size} B`);
  });

  it("keeps a name's Unicode as it is (no normalization), and makes it safe as a file name", () => {
    const nfd = "Cách.txt";
    const a = store.importBytes(nfd, Buffer.from("x"));
    expect(a.name).toBe(nfd);
    expect(a.path.endsWith(nfd)).toBe(true);
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a:b|c?.txt")).toBe("a_b_c_.txt");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName(`${"x".repeat(300)}.png`)).toMatch(/^x+\.png$/);
    expect(safeFileName(`${"x".repeat(300)}.png`).length).toBe(120);
  });

  it("refuses directories, missing files and files over the limit, and leaves nothing behind", () => {
    mkdirSync(join(t.path, "dir"));
    expect(() => store.importFile(join(t.path, "dir"))).toThrow(/is a directory/);
    expect(() => store.importFile(join(t.path, "nope.png"))).toThrow(/no such file/);
    expect(() => store.importBytes("big.bin", Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1))).toThrow(AttachmentError);
    expect(existsSync(store.root) ? readdirSync(store.root) : []).toEqual([]);
  });

  it("copies the file a symlink points at as a regular file", () => {
    const target = join(t.path, "real.txt");
    writeFileSync(target, "real\n");
    symlinkSync(target, join(t.path, "link.txt"));
    const a = store.importFile(join(t.path, "link.txt"));
    expect(readFileSync(existingAttachmentFile(runsDir, a), "utf8")).toBe("real\n");
  });

  it("resolves references only inside the runs directory", () => {
    expect(attachmentFile(runsDir, { path: "conversations/c1/attachments/x/a.png" })).toBe(join(runsDir, "conversations/c1/attachments/x/a.png"));
    for (const path of ["../outside.png", "/etc/passwd", "a/../../b", "", "a//b"]) expect(attachmentFile(runsDir, { path })).toBeNull();
    const a = store.importBytes("a.txt", Buffer.from("a"));
    store.remove(a.id);
    expect(() => existingAttachmentFile(runsDir, a)).toThrow(/no longer where agentduo kept it/);
  });

  it("adopts a file of another owner under the same id, once", () => {
    const a = store.importBytes("spec.pdf", Buffer.from("%PDF-1.4\n"));
    const run = new AttachmentStore(runsDir, join(runsDir, "20261029-run"));
    const copy = run.adopt(a);
    expect(copy).toMatchObject({ id: a.id, name: a.name, size: a.size, path: `20261029-run/attachments/${a.id}/spec.pdf` });
    store.remove(a.id);
    // Replayed (a resume): the copy is there already, so the original is not needed.
    expect(run.adopt(a)).toEqual(copy);
    expect(readFileSync(existingAttachmentFile(runsDir, copy), "utf8")).toBe("%PDF-1.4\n");
  });

  it("recovers from a crash: removes the files that were waiting and half copies, keeps those sent", () => {
    const sent = store.importBytes("sent.txt", Buffer.from("s"));
    const waiting = store.importBytes("waiting.txt", Buffer.from("w"));
    store.setPending([waiting.id]);
    mkdirSync(join(store.root, "lz-partial1"));
    writeFileSync(join(store.root, "lz-partial1", ".partial-abcd"), "half");
    writeFileSync(join(store.root, sent.id, ".partial-ffff"), "half");
    expect(store.recover()).toBe(2);
    expect(existsSync(existingAttachmentFile(runsDir, sent))).toBe(true);
    expect(readdirSync(join(store.root, sent.id))).toEqual(["sent.txt"]);
    expect(() => existingAttachmentFile(runsDir, waiting)).toThrow();
    expect(existsSync(join(store.root, "lz-partial1"))).toBe(false);
    expect(store.pending()).toEqual([]);
  });
});

describe("Conversation's waiting files", () => {
  const file = (name: string, data: string | Buffer) => {
    const p = join(t.path, name);
    writeFileSync(p, data);
    return p;
  };

  it("keep their order, refuse past a message's limits, and only go once sent", () => {
    const c = new Conversation(runsDir, { id: "c2" });
    const a = c.stage(file("a.txt", "a"));
    const b = c.stage(file("b.txt", "b"));
    expect(c.pending.map((x) => x.name)).toEqual(["a.txt", "b.txt"]);
    expect(c.files.pending()).toEqual([a.id, b.id]);
    expect(c.select([b.id])).toEqual([b]);
    // The tab's order wins: files it stored side by side may have finished in another.
    expect(c.select([b.id, a.id, b.id])).toEqual([b, a]);
    expect(() => c.select(["zz-other"])).toThrow(/no longer waiting/);
    c.sent([a]);
    expect(c.pending).toEqual([b]);
    expect(existsSync(existingAttachmentFile(runsDir, a))).toBe(true);
    expect(c.discardPending()).toEqual([b]);
    expect(() => existingAttachmentFile(runsDir, b)).toThrow();
    expect(existsSync(existingAttachmentFile(runsDir, a))).toBe(true);
  });

  it("take at most 20 files and 50 MiB in all", () => {
    const c = new Conversation(runsDir, { id: "c3" });
    for (let i = 0; i < ATTACHMENT_LIMITS.files; i++) c.stage(file(`f${i}.txt`, "x"));
    expect(() => c.stage(file("one-more.txt", "x"))).toThrow(/at most 20 files/);
    const d = new Conversation(runsDir, { id: "c4" });
    const big = file("big.bin", Buffer.alloc(ATTACHMENT_LIMITS.fileBytes));
    d.stage(big);
    d.stage(big);
    expect(() => d.stage(big)).toThrow(/50 MB in all/);
    expect(d.pending).toHaveLength(2);
  });
});

describe("selectNative", () => {
  it("sends images within Claude's budget, in order, and says why the others go as paths", () => {
    const fits = image("png", 1000, 800, 100_000, "fits");
    const wide = image("png", 8001, 10, 1000, "wide");
    const heavy = image("jpeg", 100, 100, 4_000_000, "heavy"); // 5,333,336 bytes once encoded
    const svg: Attachment = { id: "svg", name: "logo.svg", mediaType: "image/svg+xml", size: 100, image: null, path: "x/svg" };
    const pdf: Attachment = { id: "pdf", name: "a.pdf", mediaType: "application/pdf", size: 100, image: null, path: "x/pdf" };
    const { native, fallback } = selectNative("claude", [fits, pdf, wide, heavy, svg]);
    expect(native).toEqual([fits]);
    expect(fallback.map((f) => [f.attachment.id, f.reason])).toEqual([
      ["wide", "it is larger than 8000 pixels on a side"],
      ["heavy", "it is over 4.8 MB once encoded"],
      ["svg", "it is not a raster image"],
    ]);
    expect(base64Size(4_000_000)).toBe(5_333_336);
  });

  it("caps Claude at 20 images and 20 MB encoded per call, and Codex at 20 images of any size", () => {
    const many = Array.from({ length: 22 }, (_, i) => image("png", 100, 100, 1000, `p${i}`));
    expect(selectNative("claude", many).native).toHaveLength(20);
    expect(selectNative("claude", many).fallback[0]!.reason).toBe("a call takes at most 20 images");
    const fat = Array.from({ length: 5 }, (_, i) => image("png", 100, 100, 3_700_000, `f${i}`)); // 4,933,336 each
    const claude = selectNative("claude", fat);
    expect(claude.native).toHaveLength(4);
    expect(claude.fallback[0]!.reason).toMatch(/at most 19 MB once encoded/);
    expect(selectNative("codex", fat).native).toHaveLength(5);
    expect(selectNative("codex", [image("png", 9000, 9000, 19_000_000)]).native).toHaveLength(1);
    expect(selectNative("codex", many).native).toHaveLength(20);
  });
});
