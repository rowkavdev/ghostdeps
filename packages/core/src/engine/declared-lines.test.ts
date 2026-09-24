import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultPolicy } from "../recommend/index.js";
import type { Dependency, ProjectRef, RepositoryHandle } from "../types/index.js";
import { assembleAnalysisResult } from "./analyse.js";
import { declarationLineNote, verifyDeclaredLines } from "./declared-lines.js";
import type { AdapterOutcome } from "./run-adapter.js";

const MANIFEST = [
  "{",
  '  "name": "app",',
  '  "dependencies": {',
  '    "left-pad": "^1.0.0",',
  '    "@scope/pkg": "^2.0.0",',
  '    "left-pad-extra": "^1.0.0"',
  "  }",
  "}",
].join("\n");

let reads = 0;
const repo: RepositoryHandle = {
  async listFiles() {
    return ["package.json"];
  },
  async readFile(path: string) {
    reads++;
    if (path !== "package.json") throw new Error("missing");
    return MANIFEST;
  },
} as RepositoryHandle;

const project: ProjectRef = { ecosystem: "javascript-typescript", path: ".", packageManagers: [] };
const dep = (name: string, declaredLine?: unknown, declaredIn = "package.json"): Dependency =>
  ({ name, constraint: "*", kind: "runtime", project, declaredIn, declaredLine }) as Dependency;

describe("verifyDeclaredLines (#198)", () => {
  it("keeps a line that names the dependency and drops anything else", async () => {
    reads = 0;
    const out = await verifyDeclaredLines(repo, [
      dep("left-pad", 4),
      dep("@scope/pkg", 5),
      dep("left-pad", 6), // "left-pad-extra" is a different token
      dep("left-pad", 2), // wrong line
      dep("left-pad", 99), // past the end
      dep("left-pad", 0),
      dep("left-pad", 4.5),
      dep("left-pad", "4"),
      dep("left-pad", 4, "missing.json"),
      dep("left-pad"),
    ]);
    assert.deepEqual(
      out.map((d) => d.declaredLine),
      [
        4,
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    );
    assert.ok(!("declaredLine" in out[3]!), "a dropped line is removed, not set to undefined");
    assert.equal(reads, 2, "each manifest is read once");
  });
});

describe("declaration line on findings (#198)", () => {
  const outcome = (deps: Dependency[]): AdapterOutcome => ({
    ecosystem: "javascript-typescript",
    dependencies: deps,
    usages: [],
    graphs: [],
    usageAnalysed: true,
    referenceAnalysed: true,
    findings: [],
    detected: { confidence: "high", projects: [project], evidence: [] },
  });

  it("puts the verified line on the declaration evidence, with no note", async () => {
    const result = await assembleAnalysisResult(
      [outcome([{ ...dep("left-pad"), declaredLine: 4 }])],
      createDefaultPolicy({}),
    );
    const anchored = result.findings.filter((f) => f.dependency === "left-pad");
    assert.ok(anchored.length > 0);
    for (const f of anchored) {
      const decl = f.evidence.find((e) => e.file === "package.json");
      assert.equal(decl?.line, 4, f.rule);
    }
    assert.equal(declarationLineNote(result.findings), undefined);
    assert.ok(!result.findings.some((f) => f.rule === "declaration-line-unavailable"));
  });

  it("falls back to the file only and adds one note per run", async () => {
    const result = await assembleAnalysisResult(
      [outcome([dep("left-pad"), dep("right-pad")])],
      createDefaultPolicy({}),
    );
    const notes = result.findings.filter((f) => f.rule === "declaration-line-unavailable");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.kind, "info");
    assert.equal(notes[0]!.dependency, undefined);
    assert.match(notes[0]!.summary, /for 2 finding\(s\)/);
  });
});
