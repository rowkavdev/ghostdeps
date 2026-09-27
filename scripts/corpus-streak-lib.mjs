/**
 * Pure streak computation for the cap-lift clock (#172), split from
 * scripts/corpus-streak.mjs so the sequence semantics are unit-testable
 * without the Actions API.
 */
export const CAP_LIFT_TARGET = 14;
export const MISS_LIMIT = 3;

/**
 * Compute the streak from the newest-first sequence of fully elapsed days.
 *
 * days: [{ date: "2026-09-26", color: "green" | "red" | "miss" }] with
 * days[0] = yesterday. Rule (the cap ruling): green +1, red resets, a
 * no-signal day neither counts nor resets, and a third consecutive no-signal
 * day breaks the window with older history - it stops the count, but it
 * never erases a newer live streak that has already accumulated in front of
 * those misses.
 */
export function computeStreak(days, { exhaustedHistory = false } = {}) {
  let streak = 0;
  let consecutiveMisses = 0;
  let windowBroken = false;
  let lastRedDate;
  for (const { date, color } of days) {
    if (color === "green") {
      streak += 1;
      consecutiveMisses = 0;
      continue;
    }
    if (color === "red") {
      lastRedDate = date;
      break;
    }
    consecutiveMisses += 1;
    if (consecutiveMisses >= MISS_LIMIT) {
      windowBroken = true;
      break;
    }
  }
  return {
    streak,
    target: CAP_LIFT_TARGET,
    capLiftReady: streak >= CAP_LIFT_TARGET,
    consecutiveMisses,
    windowBroken,
    exhaustedHistory,
    ...(lastRedDate === undefined ? {} : { lastRedDate }),
  };
}
