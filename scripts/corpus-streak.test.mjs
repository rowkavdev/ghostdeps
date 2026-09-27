// Sequence tests for the cap-lift streak (#172 review): the day walk is pure,
// so every rule of the cap ruling is pinned without the Actions API.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStreak } from "./corpus-streak-lib.mjs";

const day = (n, color) => ({ date: `2026-09-${String(n).padStart(2, "0")}`, color });

test("a third old miss breaks the window but keeps the newer live streak", () => {
  // Newest first: 2 green, then 3 misses, then older greens the misses cut off.
  const days = [
    day(26, "green"),
    day(25, "green"),
    day(24, "miss"),
    day(23, "miss"),
    day(22, "miss"),
    day(21, "green"),
    day(20, "green"),
  ];
  const s = computeStreak(days);
  assert.equal(s.streak, 2);
  assert.equal(s.windowBroken, true);
  assert.equal(s.capLiftReady, false);
});

test("red resets: greens older than a red do not count", () => {
  const days = [day(26, "green"), day(25, "green"), day(24, "red"), day(23, "green")];
  const s = computeStreak(days);
  assert.equal(s.streak, 2);
  assert.equal(s.lastRedDate, "2026-09-24");
  assert.equal(s.windowBroken, false);
});

test("one or two misses neither count nor reset", () => {
  const s = computeStreak([day(26, "miss"), day(25, "miss")]);
  assert.equal(s.streak, 0);
  assert.equal(s.consecutiveMisses, 2);
  assert.equal(s.windowBroken, false);
});

test("three most-recent misses break the window at zero", () => {
  const s = computeStreak([day(26, "miss"), day(25, "miss"), day(24, "miss")]);
  assert.equal(s.streak, 0);
  assert.equal(s.windowBroken, true);
});

test("a single missed day inside a green run only pauses the count", () => {
  const days = [day(26, "green"), day(25, "miss"), day(24, "green"), day(23, "green")];
  const s = computeStreak(days);
  assert.equal(s.streak, 3);
  assert.equal(s.windowBroken, false);
});

test("fourteen consecutive greens lift the cap", () => {
  const days = Array.from({ length: 14 }, (_, i) => day(26 - i, "green"));
  const s = computeStreak(days);
  assert.equal(s.streak, 14);
  assert.equal(s.capLiftReady, true);
});

test("thirteen greens are not enough", () => {
  const days = Array.from({ length: 13 }, (_, i) => day(26 - i, "green"));
  assert.equal(computeStreak(days).capLiftReady, false);
});

test("recorded history running out ends the count without breaking the window", () => {
  const s = computeStreak([day(26, "green"), day(25, "green")], { exhaustedHistory: true });
  assert.equal(s.streak, 2);
  assert.equal(s.exhaustedHistory, true);
  assert.equal(s.windowBroken, false);
});

test("empty sequence is a zero streak", () => {
  const s = computeStreak([], { exhaustedHistory: true });
  assert.equal(s.streak, 0);
  assert.equal(s.capLiftReady, false);
});
