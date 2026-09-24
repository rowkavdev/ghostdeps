import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findingGroup } from "./finding-group.js";
import type { Finding, FindingKind } from "./index.js";

const finding = (kind: FindingKind, extra: Partial<Finding> = {}): Finding => ({
  kind,
  summary: "s",
  recommendation: "r",
  evidence: [],
  confidence: "high",
  limitations: [],
  affectedFiles: [],
  ...extra,
});

describe("findingGroup (#234)", () => {
  it("awareness only when an info finding says awareness: true", () => {
    assert.equal(
      findingGroup(finding("info", { awareness: true, dependency: "axios" })),
      "awareness",
    );
  });

  it("any other info finding is a note, with or without a dependency", () => {
    assert.equal(findingGroup(finding("info")), "note");
    assert.equal(
      findingGroup(finding("info", { dependency: "left-pad", rule: "unverified-no-imports" })),
      "note",
    );
  });

  it("fails closed on anything but an explicit true", () => {
    for (const odd of [false, "true", 1, null, {}] as unknown[]) {
      assert.equal(findingGroup({ kind: "info", awareness: odd as true }), "note", String(odd));
    }
  });

  it("non-info findings are verdicts, even if they claim awareness", () => {
    const kinds: FindingKind[] = [
      "unused",
      "potentially-unnecessary",
      "duplicate-capability",
      "maintenance-risk",
      "footprint",
      "should-be-dev",
      "type-only",
    ];
    for (const kind of kinds) {
      assert.equal(findingGroup(finding(kind, { awareness: true })), "verdict", kind);
    }
  });
});
