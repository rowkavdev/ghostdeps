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

describe("findingGroup (#239)", () => {
  it("awareness: an info finding with awareness: true", () => {
    assert.equal(
      findingGroup(finding("info", { awareness: true, dependency: "axios" })),
      "awareness",
    );
  });

  it("note: an info finding the engine marked adapterNote: true", () => {
    assert.equal(findingGroup(finding("info", { adapterNote: true })), "note");
  });

  it("incomplete: every unmarked info finding (engine notes, unverified-no-imports, ...)", () => {
    assert.equal(findingGroup(finding("info", { rule: "scan-truncated" })), "incomplete");
    assert.equal(findingGroup(finding("info", { rule: "unused-confidence-capped" })), "incomplete");
    assert.equal(
      findingGroup(finding("info", { dependency: "left-pad", rule: "unverified-no-imports" })),
      "incomplete",
    );
    assert.equal(findingGroup(finding("info", { rule: "some-future-rule" })), "incomplete");
  });

  it("fails closed on anything but an explicit true", () => {
    for (const odd of [false, "true", 1, null, {}] as unknown[]) {
      assert.equal(
        findingGroup({ kind: "info", awareness: odd as true }),
        "incomplete",
        String(odd),
      );
      assert.equal(
        findingGroup({ kind: "info", adapterNote: odd as true }),
        "incomplete",
        String(odd),
      );
    }
  });

  it("awareness wins over adapterNote", () => {
    assert.equal(findingGroup({ kind: "info", awareness: true, adapterNote: true }), "awareness");
  });

  it("non-info findings are verdicts, whatever markers they claim", () => {
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
      assert.equal(
        findingGroup(finding(kind, { awareness: true, adapterNote: true })),
        "verdict",
        kind,
      );
    }
  });
});
