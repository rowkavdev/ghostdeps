import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisResult, Finding } from "@ghostdeps/core";
import { renderPrComment, type FindingEligibility } from "./render.js";
import { eligibilityId } from "./resolve.js";
import type { Dependency } from "@ghostdeps/core";
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

const ROOT_DEP: Dependency = {
  name: "left-pad",
  constraint: "^1.3.0",
  kind: "dependencies",
  project: { path: ".", ecosystem: "javascript", packageManagers: [] },
  declaredIn: "package.json",
} as unknown as Dependency;

function result(findings: Finding[], dependencies: Dependency[] = [ROOT_DEP]): AnalysisResult {
  return { findings, dependencies } as unknown as AnalysisResult;
}

function render(over: Partial<Parameters<typeof renderPrComment>[0]> = {}) {
  return renderPrComment({
    result: result([finding({})]),
    repositoryId: 5,
    pullNumber: 9,
    headSha: SHA,
    eligibility: new Map<string, FindingEligibility>([
      [eligibilityId("unused", ".", "left-pad"), { status: "eligible", key: KEY }],
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
          eligibilityId("unused", ".", "left-pad"),
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

  it("round-trips the marker at the 25-tickbox boundary (reviewer-1 #425)", () => {
    const n = 25;
    const deps = Array.from({ length: n }, (_, i) => ({
      ...ROOT_DEP,
      name: `dep-${i}`,
    })) as unknown as Dependency[];
    const findings = deps.map((d, i) => finding({ dependency: `dep-${i}` }));
    const eligibility = new Map<string, FindingEligibility>(
      deps.map((d, i) => [
        eligibilityId("unused", ".", `dep-${i}`),
        { status: "eligible", key: i.toString(16).padStart(64, "0") },
      ]),
    );
    const body = render({ result: result(findings, deps), eligibility });
    const marker = parseMarker(body);
    assert.equal(marker?.keys.length, n);
    assert.equal((body.match(/- \[ \]/g) ?? []).length, n);
    for (const key of marker!.keys) assert.match(body, new RegExp(`gd-key:${key}`));
  });

  it("never shows more tickboxes than the marker carries, even with 48 eligible findings", () => {
    const n = 48;
    const deps = Array.from({ length: n }, (_, i) => ({
      ...ROOT_DEP,
      name: `dep-${i}`,
    })) as unknown as Dependency[];
    const findings = deps.map((_, i) => finding({ dependency: `dep-${i}` }));
    const eligibility = new Map<string, FindingEligibility>(
      deps.map((_, i) => [
        eligibilityId("unused", ".", `dep-${i}`),
        { status: "eligible", key: i.toString(16).padStart(64, "0") },
      ]),
    );
    const body = render({ result: result(findings, deps), eligibility });
    const marker = parseMarker(body);
    assert.equal(marker?.keys.length, 25);
    assert.equal((body.match(/- \[ \]/g) ?? []).length, 25);
    assert.match(body, /beyond this comment's tickbox budget/);
    // The marker names exactly the keys whose checkboxes are visible.
    const visible = [...body.matchAll(/gd-key:([0-9a-f]{64})/g)].map((m) => m[1]);
    assert.deepEqual([...visible].sort(), [...marker!.keys].sort());
  });

  it("renders duplicate findings for the same rule and dependency only once tickable", () => {
    const body = render({
      result: result([finding({}), finding({})]),
      eligibility: new Map([
        [eligibilityId("unused", ".", "left-pad"), { status: "eligible", key: KEY }],
      ]),
    });
    assert.equal((body.match(/- \[ \]/g) ?? []).length, 1);
    assert.deepEqual(parseMarker(body)?.keys, [KEY]);
    assert.match(body, /duplicate of an entry above/);
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
