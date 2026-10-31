// The site search (assets/search-core.js, the same module the browser runs) over records shaped like the index.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, search, snippet, terms } from "../assets/search-core.js";
import { buildIndex } from "../lib/search.mjs";

const RECORDS = [
  { p: "Yêu cầu", s: "Đăng nhập", u: "/vi/learn/prerequisites/#login", x: "Chạy claude rồi đăng nhập bằng tài khoản Claude; với Codex, chạy codex login." },
  { p: "Cấu hình", s: "Thứ tự ghi đè", u: "/vi/docs/configuration/#order", x: "Mặc định, rồi cấu hình người dùng, rồi cấu hình dự án." },
  { p: "The pipeline", s: "Gates", u: "/docs/pipeline/#gates", x: "A gate is a command such as npm test that runs in VERIFY." },
  { p: "Gates and limits", s: "", u: "/docs/config-reference/", x: "Every key under limits.", top: true },
];

test("matching ignores case and Vietnamese accents, and đ matches d", () => {
  assert.equal(normalize("Đăng NHẬP"), "dang nhap");
  const hits = search(RECORDS, "dang nhap");
  assert.equal(hits[0].u, "/vi/learn/prerequisites/#login");
  assert.equal(search(RECORDS, "đăng nhập")[0].u, "/vi/learn/prerequisites/#login");
});

test("every word must match, and a title match ranks first", () => {
  assert.deepEqual(search(RECORDS, "gate npm").map((r) => r.u), ["/docs/pipeline/#gates"]);
  assert.equal(search(RECORDS, "gates")[0].u, "/docs/config-reference/");
});

test("no result and empty queries give an empty list", () => {
  assert.deepEqual(search(RECORDS, "kubernetes"), []);
  assert.deepEqual(search(RECORDS, "   "), []);
  assert.deepEqual(terms("  \"quoted\", words!  "), ["quoted", "words"]);
});

test("a snippet shows the original words around the match", () => {
  const parts = snippet(RECORDS[0], "dang nhap");
  assert.equal(parts.map((x) => x.text).join(""), RECORDS[0].x);
  assert.deepEqual(parts.filter((x) => x.match).map((x) => x.text), ["đăng", "nhập"]);
});

test("the index has a record per page and per section, without noindex pages", () => {
  const index = buildIndex([
    { page: { id: "docs/cli" }, route: "/docs/cli/", mod: { title: "duo <code>commands</code>", description: "All of duo.", sections: [{ id: "exit-codes", title: "Exit codes", html: "<p>0 means done.</p>" }] } },
    { page: { id: "search", noindex: true }, route: "/search/", mod: { title: "Search", description: "x", sections: [] } },
  ]);
  assert.deepEqual(index.map((r) => r.u), ["/docs/cli/", "/docs/cli/#exit-codes"]);
  assert.equal(index[0].p, "duo commands");
  assert.equal(index[1].x, "0 means done.");
});
