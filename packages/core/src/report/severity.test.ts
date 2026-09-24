import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Confidence, Finding, FindingKind } from "../types/index.js";
import {
  UNUSED_SEVERITY_CAP,
  atOrAboveSeverity,
  parseSeverity,
  severityOf,
  severityOrder,
} from "./severity.js";

const finding = (kind: FindingKind, confidence: Confidence): Finding => ({
  kind,
  summary: "s",
  recommendation: "r",
  evidence: [],
  confidence,
  limitations: [],
  affectedFiles: [],
});

describe("severityOf", () => {
  it("derives severity from the kind ceiling and confidence", () => {
    assert.equal(severityOf(finding("unused", "high")), "medium");
    assert.equal(severityOf(finding("unused", "medium")), "low");
    assert.equal(severityOf(finding("unused", "low")), "info");
    assert.equal(severityOf(finding("should-be-dev", "high")), "medium");
    assert.equal(severityOf(finding("type-only", "high")), "medium");
    assert.equal(severityOf(finding("duplicate-capability", "high")), "medium");
    assert.equal(severityOf(finding("potentially-unnecessary", "high")), "low");
    assert.equal(severityOf(finding("maintenance-risk", "high")), "low");
    assert.equal(severityOf(finding("footprint", "high")), "low");
    assert.equal(severityOf(finding("should-be-dev", "low")), "info");
  });

  it("caps unused at medium until the corpus check has been green for 14 days (#173 contract)", () => {
    // Shipping gate. Lifting the cap means changing UNUSED_SEVERITY_CAP and
    // this test in the same PR - never one without the other.
    assert.equal(UNUSED_SEVERITY_CAP, "medium");
    for (const confidence of ["high", "medium", "low"] as const) {
      assert.equal(atOrAboveSeverity(finding("unused", confidence), "high"), false);
    }
    // A ceiling, never a floor: confidence downgrades still apply below it.
    assert.equal(severityOf(finding("unused", "high")), "medium");
    assert.equal(severityOf(finding("unused", "low")), "info");
  });

  it("never rates info findings above info, whatever the confidence", () => {
    assert.equal(severityOf(finding("info", "high")), "info");
    // #110's scan-completeness notes must never trip --fail-on high.
    assert.equal(atOrAboveSeverity(finding("info", "high"), "high"), false);
  });

  it("maps every FindingKind explicitly (contract test)", () => {
    // A new FindingKind must be placed in the ceiling table deliberately.
    // The Record type enforces this at compile time; this test keeps the
    // runtime honest if a cast ever bypasses it.
    const kinds: FindingKind[] = [
      "unused",
      "potentially-unnecessary",
      "duplicate-capability",
      "maintenance-risk",
      "footprint",
      "should-be-dev",
      "type-only",
      "info",
    ];
    for (const kind of kinds) {
      assert.ok(severityOrder.includes(severityOf(finding(kind, "high"))), `${kind} has a mapping`);
    }
  });

  it("drops unknown kinds to info instead of throwing", () => {
    assert.equal(severityOf(finding("future-kind" as FindingKind, "high")), "info");
  });

  it("compares findings against thresholds and parses names", () => {
    assert.equal(atOrAboveSeverity(finding("should-be-dev", "high"), "medium"), true);
    assert.equal(atOrAboveSeverity(finding("should-be-dev", "high"), "high"), false);
    assert.equal(atOrAboveSeverity(finding("unused", "medium"), "low"), true);
    assert.equal(parseSeverity("high"), "high");
    assert.equal(parseSeverity("bogus"), undefined);
  });
});
