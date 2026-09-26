import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisResult, Finding } from "@ghostdeps/core";
import { eligibilityId, renderPrComment, type FindingEligibility } from "./render.js";
import { parseMarker } from "./marker.js";

const SHA = "c".repeat(40);
const KEY = "d".repeat(64);

function finding(over: Partial<Finding>): Finding {
  return {
    kind: "verdict",
    rule: "unused",
    dependency: "left-pad",
    summary: "left-pad is declared but never used",
    recommendation: "Remove it.",
    evidence: [],
    confidence: "medium",
    ...over,
  } as Finding;
}

function result(findings: Finding[]): AnalysisResult {
  return { findings } as unknown as AnalysisResult;
}

function render(over: Partial<Parameters<typeof renderPrComment>[0]> = {}) {
  return renderPrComment({
    result: result([finding({})]),
    repositoryId: 5,
    pullNumber: 9,
    headSha: SHA,
    eligibility: new Map<string, FindingEligibility>([
      [eligibilityId("unused", "left-pad"), { status: "eligible", key: KEY }],
    ]),
    applyAvailable: false,
    ...over,
  });
}

describe("renderPrComment", () => {
  it("renders the marker on the first line with the eligible key", () => {
    const body = render();
    const marker = parseMarker(body);
    assert.deepEqual(marker, { repositoryId: 5, pullNumber: 9, headSha: SHA, keys: [KEY] });
  });

  it("gives a tickbox only to an eligible finding, with the key bound on the line", () => {
    const body = render();
    assert.match(
      body,
      new RegExp(`^- \\[ \\] \\*\\*unused \`left-pad\`\\*\\*.*<!-- gd-key:${KEY} -->$`, "m"),
    );
  });

  it("renders ineligible findings explanation-only with the refusal reason", () => {
    const body = render({
      eligibility: new Map([
        [
          eligibilityId("unused", "left-pad"),
          { status: "ineligible", reason: "nested manifests are not supported" },
        ],
      ]),
    });
    assert.doesNotMatch(body, /- \[ \]/);
    assert.match(body, /No tickbox: nested manifests are not supported/);
    assert.deepEqual(parseMarker(body)?.keys, []);
  });

  it("never tickboxes a rule outside the ADR 0005 set", () => {
    const body = render({
      result: result([finding({ rule: "native-alternative" })]),
    });
    assert.doesNotMatch(body, /- \[ \]/);
    assert.match(body, /explanation-only/);
  });

  it("says plainly that apply is not enabled when applyAvailable is false", () => {
    assert.match(render(), /Tick-to-apply is not enabled on this installation yet/);
  });

  it("escapes markdown controls and caps repository-controlled text", () => {
    const evil = "x`".repeat(400);
    const body = render({ result: result([finding({ dependency: "left-pad", summary: evil })]) });
    assert.ok(!body.includes("``"));
    assert.ok(body.length < 60_000);
  });

  it("renders repository-wide notes in their own section", () => {
    const body = render({
      result: result([
        finding({}),
        finding({
          dependency: undefined as unknown as string,
          rule: undefined as unknown as string,
          summary: "unused confidence capped pending corpus validation",
        }),
      ]),
    });
    assert.match(body, /### Notes\n- unused confidence capped/);
  });
});
