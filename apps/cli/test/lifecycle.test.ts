import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { guardStream, processIO } from "../src/cli.js";

describe("process lifecycle", () => {
  it("ignores EPIPE on output streams (e.g. piping into head) but not other errors", () => {
    const stream = new EventEmitter();
    guardStream(stream);
    expect(() => stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
    expect(() => stream.emit("error", Object.assign(new Error("boom"), { code: "EIO" }))).toThrow("boom");
  });

  it("treats a closed terminal (SIGHUP) like Ctrl-C", () => {
    let calls = 0;
    const off = processIO().onSignal!(() => {
      calls += 1;
    });
    process.emit("SIGHUP");
    off();
    process.emit("SIGHUP");
    expect(calls).toBe(1);
  });
});
