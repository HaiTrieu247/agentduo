import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "../src/duration.js";

test("seconds only", () => {
  assert.equal(formatDuration(7), "7s");
});

test("minutes and seconds", () => {
  assert.equal(formatDuration(249), "4m 09s");
});

test("hours, minutes and seconds", () => {
  assert.equal(formatDuration(3725), "1h 02m 05s");
});
