import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { createDefaultPolicy } from "../recommend/index.js";
import {
  findingGroup,
  type Evidence,
  type ProjectRef,
  type RepositoryHandle,
} from "../types/index.js";
import { analyseRepository } from "./analyse.js";
import { MAX_MALFORMED_MANIFEST_NOTES, manifestMalformedNotes } from "./manifest-malformed.js";

const handle: RepositoryHandle = {
  async listFiles() {
    return ["package.json"];
  },
  async readFile() {
    return "{}";
  },
  async exists(p) {
    return p === "package.json";
  },
};

function adapter(ecosystem: string, evidence: Evidence[], confidence = 0.9): EcosystemAdapter {
  const project: ProjectRef = { path: ".", ecosystem, packageManagers: [] };
  return {
    ecosystem,
    apiVersion: adapterApiVersion,
    capabilities: new Set(["usageAnalysis", "referenceAnalysis"]),
    async detect() {
      return { confidence, projects: [project], evidence };
    },
    async listDirectDependencies() {
      return [{ name: "left-pad", constraint: "^1", kind: "runtime", project, declaredIn: "m" }];
    },
    async findUsage() {
      return { usages: [], referenceAnalysisComplete: true };
    },
  };
}

const malformed = (file: string, line?: number): Evidence => ({
  kind: "manifest-malformed",
  statement: `${file} is broken`,
  file,
  ...(line !== undefined ? { line } : {}),
});

describe("manifest-malformed mapping (#269)", () => {
  it("turns adapter evidence into one incomplete note per manifest and caps verdicts", async () => {
    const clean = await analyseRepository(handle, {
      adapters: [adapter("python", [])],
      recommend: createDefaultPolicy(),
    });
    assert.ok(
      clean.findings.some((f) => f.kind === "unused"),
      "baseline reaches a verdict",
    );
    assert.ok(!clean.findings.some((f) => f.rule === "manifest-malformed"));

    const result = await analyseRepository(handle, {
      adapters: [
        adapter("python", [malformed("pyproject.toml")]),
        adapter("go", [malformed("go.mod", 7), malformed("go.mod", 8)]),
      ],
      recommend: createDefaultPolicy(),
    });
    const notes = result.findings.filter((f) => f.rule === "manifest-malformed");
    assert.deepEqual(notes.map((n) => n.affectedFiles).sort(), [["go.mod"], ["pyproject.toml"]]);
    for (const note of notes) assert.equal(findingGroup(note), "incomplete");
    const go = notes.find((n) => n.affectedFiles[0] === "go.mod")!;
    assert.deepEqual(
      go.evidence.map((e) => e.line),
      [7, 8],
    );
    // Scan-completeness semantics (#154): no confident unused verdict.
    assert.ok(
      !result.findings.some((f) => f.kind === "unused" && f.confidence === "high"),
      JSON.stringify(result.findings.map((f) => [f.kind, f.confidence])),
    );
  });

  it("ignores other evidence kinds and undetected ecosystems", async () => {
    const result = await analyseRepository(handle, {
      adapters: [
        adapter("js", [{ kind: "manifest-found", statement: "ok", file: "package.json" }]),
        adapter("python", [malformed("pyproject.toml")], 0.1),
      ],
    });
    assert.ok(!result.findings.some((f) => f.rule === "manifest-malformed"));
  });

  it("caps notes per run with one overflow note", () => {
    const evidence = Array.from({ length: MAX_MALFORMED_MANIFEST_NOTES + 3 }, (_, i) =>
      malformed(`p${String(i).padStart(3, "0")}/pyproject.toml`),
    );
    const notes = manifestMalformedNotes([{ ecosystem: "python", evidence }]);
    assert.equal(notes.length, MAX_MALFORMED_MANIFEST_NOTES + 1);
    assert.match(notes.at(-1)!.summary, /^3 more manifest/);
  });
});
