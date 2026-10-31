// The preview server answers as the static host should: pages, directory redirects, 404 with the right page and
// status, and nothing outside the served folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startPreview } from "../scripts/preview.mjs";

let dir, server, base;
before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "agentduo-preview-"));
  dir = join(tmp, "dist");
  mkdirSync(join(dir, "docs", "cli"), { recursive: true });
  mkdirSync(join(dir, "vi"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "home");
  writeFileSync(join(dir, "docs", "cli", "index.html"), "cli");
  writeFileSync(join(dir, "404.html"), "en-404");
  writeFileSync(join(dir, "vi", "404.html"), "vi-404");
  writeFileSync(join(tmp, "secret.txt"), "secret");
  server = await startPreview({ dir, port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

const get = (path) => fetch(base + path, { redirect: "manual" });

test("a page and a directory route are served with 200", async () => {
  for (const [path, body] of [["/", "home"], ["/docs/cli/", "cli"]]) {
    const r = await get(path);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), body);
    assert.match(r.headers.get("content-type"), /text\/html/);
  }
});

test("a directory without its slash redirects to it", async () => {
  const r = await get("/docs/cli?x=1");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/docs/cli/?x=1");
});

test("a missing path answers 404 with its language's page, at any depth", async () => {
  let r = await get("/no/such/deep/page/");
  assert.equal(r.status, 404);
  assert.equal(await r.text(), "en-404");
  r = await get("/vi/khong/co/");
  assert.equal(r.status, 404);
  assert.equal(await r.text(), "vi-404");
});

test("nothing outside the served folder can be read", async () => {
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/docs/%2e%2e/%2e%2e/secret.txt"]) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.notEqual(await r.text(), "secret");
  }
});
