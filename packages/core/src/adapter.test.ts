import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseUsageResult } from "./adapter.js";
import type { Usage } from "./types/index.js";

const usage: Usage = { dependency: "a", file: "src/a.ts", line: 1, form: "static", symbols: [] };

describe("normaliseUsageResult", () => {
  it("reads an array as incomplete reference analysis", () => {
    assert.deepEqual(normaliseUsageResult([usage]), {
      usages: [usage],
      referenceAnalysisComplete: false,
    });
  });

  it("reads an omitted or false flag as incomplete", () => {
    assert.equal(normaliseUsageResult({ usages: [] }).referenceAnalysisComplete, false);
    assert.equal(
      normaliseUsageResult({ usages: [], referenceAnalysisComplete: false })
        .referenceAnalysisComplete,
      false,
    );
  });

  it("only an explicit true is complete", () => {
    assert.deepEqual(normaliseUsageResult({ usages: [usage], referenceAnalysisComplete: true }), {
      usages: [usage],
      referenceAnalysisComplete: true,
    });
  });
});
