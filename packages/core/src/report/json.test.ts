import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { jsonSchemaVersion, normaliseAnalysisResult, renderJsonReport } from "./json.js";
import type { AnalysisResult, ProjectRef } from "../types/index.js";

/** Golden files live in packages/core/test/golden (tests run from dist/report). */
const golden = (name: string): URL => new URL(`../../test/golden/${name}`, import.meta.url);

/** Set UPDATE_GOLDEN=1 to rewrite golden files after an intended schema change. */
function assertGolden(name: string, actual: string): void {
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden(name), actual);
  assert.equal(actual, readFileSync(golden(name), "utf8"));
}

const root: ProjectRef = {
  path: ".",
  ecosystem: "javascript-typescript",
  packageManagers: [{ name: "npm" }],
};

/** The result a correct analysis of fixtures/js/basic-unused produces. */
const basicUnused: AnalysisResult = {
  schemaVersion: 1,
  projects: [root],
  dependencies: [
    {
      name: "left-pad",
      constraint: "^1.3.0",
      kind: "runtime",
      project: root,
      declaredIn: "package.json",
      specifier: { type: "registry" },
    },
  ],
  usages: [],
  findings: [
    {
      kind: "unused",
      dependency: "left-pad",
      summary: "left-pad is declared but never imported.",
      recommendation: "Consider whether left-pad is needed; nothing imports it.",
      evidence: [
        {
          kind: "declared",
          statement: "declared in dependencies",
          file: "package.json",
          line: 6,
        },
        { kind: "no-import-found", statement: "no import or require of left-pad in 1 source file" },
      ],
      confidence: "high",
      limitations: [],
      affectedFiles: ["package.json"],
    },
  ],
  detected: [
    {
      ecosystem: "javascript-typescript",
      confidence: "high",
      evidence: [{ kind: "manifest-found", statement: "package.json", file: "package.json" }],
    },
  ],
  surface: [{ ecosystem: "javascript-typescript", direct: 1, transitive: 1, graphs: "complete" }],
};

describe("renderJsonReport", () => {
  it("writes schemaVersion first and matches the golden file for js/basic-unused", () => {
    const out = renderJsonReport(basicUnused);
    assert.equal(jsonSchemaVersion, 1);
    assert.match(out, /^\{\n {2}"schemaVersion": 1,\n/);
    assert.ok(out.endsWith("}\n"));
    assertGolden("js-basic-unused.json", out);
  });

  it("round-trips to the same data", () => {
    const parsed = JSON.parse(renderJsonReport(basicUnused)) as AnalysisResult;
    assert.deepEqual(parsed, basicUnused);
  });

  it("is independent of input key and collection order", () => {
    const b: ProjectRef = { path: "packages/b", ecosystem: "python", packageManagers: [] };
    const a: ProjectRef = { ecosystem: "javascript-typescript", packageManagers: [], path: "." };
    const make = (reverse: boolean): AnalysisResult => {
      const order = <T>(items: T[]): T[] => (reverse ? [...items].reverse() : items);
      return {
        surface: order([
          { ecosystem: "javascript-typescript", direct: 2, transitive: 9 },
          { ecosystem: "python", direct: 1, transitive: 3 },
        ]),
        detected: [],
        findings: order([
          { ...basicUnused.findings[0]!, dependency: "axios", kind: "potentially-unnecessary" },
          { ...basicUnused.findings[0]!, dependency: "requests", kind: "info" },
        ]),
        usages: order([
          { dependency: "axios", file: "src/b.ts", line: 4, form: "static", symbols: ["get"] },
          { dependency: "axios", file: "src/a.ts", line: 10, form: "static", symbols: ["get"] },
          { dependency: "axios", file: "src/a.ts", line: 2, form: "static", symbols: ["get"] },
        ]),
        dependencies: order([
          {
            name: "axios",
            constraint: "^1",
            kind: "runtime",
            project: a,
            declaredIn: "package.json",
          },
          {
            name: "requests",
            constraint: ">=2",
            kind: "runtime",
            project: b,
            declaredIn: "packages/b/pyproject.toml",
          },
        ]),
        projects: order([a, b]),
        schemaVersion: 1,
      };
    };
    const forward = renderJsonReport(make(false));
    assert.equal(renderJsonReport(make(true)), forward);
    const lines = (JSON.parse(forward) as AnalysisResult).usages.map((u) => `${u.file}:${u.line}`);
    assert.deepEqual(lines, ["src/a.ts:2", "src/a.ts:10", "src/b.ts:4"]);
  });

  it("keeps evidence order inside a finding", () => {
    const parsed = JSON.parse(renderJsonReport(basicUnused)) as AnalysisResult;
    assert.deepEqual(
      parsed.findings[0]!.evidence.map((e) => e.kind),
      ["declared", "no-import-found"],
    );
  });

  it("omits undefined fields", () => {
    const withUndefined = {
      ...basicUnused,
      findings: [{ ...basicUnused.findings[0]!, dependency: undefined }],
    } as unknown as AnalysisResult;
    assert.doesNotMatch(renderJsonReport(withUndefined), /"dependency"/);
  });

  it("escapes invisible and bidi characters from repository content", () => {
    const hostile = "evil\u202ecod\u2066e\u200b\u2028x";
    const out = renderJsonReport({
      ...basicUnused,
      findings: [{ ...basicUnused.findings[0]!, summary: hostile }],
    });
    assert.doesNotMatch(out, /[\u200b\u2028\u202e\u2066]/);
    assert.match(out, /evil\\u202ecod\\u2066e\\u200b\\u2028x/);
    const parsed = JSON.parse(out) as AnalysisResult;
    assert.equal(parsed.findings[0]!.summary, hostile);
  });

  it("rejects unknown schema versions and non-finite numbers", () => {
    assert.throws(
      () => renderJsonReport({ ...basicUnused, schemaVersion: 2 as unknown as 1 }),
      RangeError,
    );
    assert.throws(
      () =>
        renderJsonReport({
          ...basicUnused,
          surface: [{ ecosystem: "x", direct: Number.NaN, transitive: 0 }],
        }),
      TypeError,
    );
  });

  it("rejects Map, Date and class instances instead of dropping their data", () => {
    const withMap = {
      ...basicUnused,
      surface: [new Map([["x", 1]])],
    } as unknown as AnalysisResult;
    assert.throws(() => renderJsonReport(withMap), /cannot serialise Map/);
    const withDate = {
      ...basicUnused,
      detected: [{ ecosystem: "x", confidence: "high", evidence: [], at: new Date(0) }],
    } as unknown as AnalysisResult;
    assert.throws(() => renderJsonReport(withDate), /cannot serialise Date/);
  });

  it("orders look-alike findings by location, then by content", () => {
    const at = (file: string, line: number, extra = "") => ({
      ...basicUnused.findings[0]!,
      evidence: [{ kind: "import-found", statement: `seen${extra}`, file, line }],
    });
    const findings = [at("b.ts", 1), at("a.ts", 9), at("a.ts", 2), at("a.ts", 2, "!")];
    const render = (list: typeof findings) => renderJsonReport({ ...basicUnused, findings: list });
    const forward = render(findings);
    assert.equal(render([...findings].reverse()), forward);
    const order = (JSON.parse(forward) as AnalysisResult).findings.map(
      (f) => `${f.evidence[0]!.file}:${f.evidence[0]!.line}:${f.evidence[0]!.statement}`,
    );
    assert.deepEqual(order, ["a.ts:2:seen!", "a.ts:2:seen", "a.ts:9:seen", "b.ts:1:seen"]);
  });

  it("escapes soft hyphen, Arabic letter mark and Mongolian vowel separator", () => {
    const name = "left\u00adpad\u061c\u180e";
    const out = renderJsonReport({
      ...basicUnused,
      findings: [{ ...basicUnused.findings[0]!, dependency: name }],
    });
    assert.match(out, /left\\u00adpad\\u061c\\u180e/);
    assert.equal((JSON.parse(out) as AnalysisResult).findings[0]!.dependency, name);
  });

  it("normalises tied findings with a non-plain value without throwing", () => {
    const odd = {
      ...basicUnused.findings[0]!,
      evidence: [{ kind: "x", statement: "odd", extra: new Map([["k", 1]]) }],
    } as unknown as AnalysisResult["findings"][number];
    const plain = { ...basicUnused.findings[0]!, evidence: [{ kind: "x", statement: "odd" }] };
    const result = { ...basicUnused, findings: [odd, plain] };
    const normalised = normaliseAnalysisResult(result);
    assert.equal(normalised.findings.length, 2);
    assert.throws(() => renderJsonReport(result), /cannot serialise Map/);
  });
});
