import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultPolicy } from "../recommend/index.js";
import type { Dependency, ProjectRef, RepositoryHandle } from "../types/index.js";
import { assembleAnalysisResult } from "./analyse.js";
import {
  declarationLineNote,
  MAX_VERIFIED_MANIFEST_CHARS,
  MAX_VERIFIED_MANIFESTS,
  pep503,
  verifyDeclaredLines,
} from "./declared-lines.js";
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

  it("caps manifest reads and drops lines past the cap", async () => {
    let count = 0;
    const many: RepositoryHandle = {
      ...repo,
      async readFile() {
        count++;
        return MANIFEST;
      },
    };
    const deps = Array.from({ length: MAX_VERIFIED_MANIFESTS + 5 }, (_, i) =>
      dep("left-pad", 4, `p${i}/package.json`),
    );
    const out = await verifyDeclaredLines(many, deps);
    assert.equal(count, MAX_VERIFIED_MANIFESTS);
    assert.equal(out.filter((d) => d.declaredLine === 4).length, MAX_VERIFIED_MANIFESTS);
  });

  it("does not verify an oversized manifest", async () => {
    const big: RepositoryHandle = {
      ...repo,
      async readFile() {
        return MANIFEST + " ".repeat(MAX_VERIFIED_MANIFEST_CHARS);
      },
    };
    const [out] = await verifyDeclaredLines(big, [dep("left-pad", 4)]);
    assert.equal(out!.declaredLine, undefined);
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

describe("python declared lines under PEP 503 (#286)", () => {
  const PYPROJECT = [
    "[project]",
    "dependencies = [",
    '  "pyyaml>=6",',
    '  "typing-extensions",',
    "  \"Ruamel.Yaml[jinja2]==0.18 ; python_version < '3.13'\",",
    '  "pyyaml-include",',
    "]",
  ].join("\n");
  const pyRepo = {
    async readFile(path: string) {
      if (path !== "pyproject.toml") throw new Error("missing");
      return PYPROJECT;
    },
  } as RepositoryHandle;
  const py: ProjectRef = { ecosystem: "python", path: ".", packageManagers: [] };
  const pyDep = (name: string, declaredLine: number, p: ProjectRef = py): Dependency =>
    ({
      name,
      constraint: "*",
      kind: "runtime",
      project: p,
      declaredIn: "pyproject.toml",
      declaredLine,
    }) as Dependency;

  it("keeps a python line that names the dependency under PEP 503", async () => {
    const out = await verifyDeclaredLines(pyRepo, [
      pyDep("PyYAML", 3),
      pyDep("typing_extensions", 4),
      pyDep("ruamel-yaml", 5),
      pyDep("pyyaml", 6), // "pyyaml-include" is a different package
      pyDep("PyYAML", 4), // wrong line
    ]);
    assert.deepEqual(
      out.map((d) => d.declaredLine),
      [3, 4, 5, undefined, undefined],
    );
  });

  it("keeps the exact comparison for other ecosystems", async () => {
    const other: ProjectRef = {
      ecosystem: "javascript-typescript",
      path: ".",
      packageManagers: [],
    };
    const out = await verifyDeclaredLines(pyRepo, [
      pyDep("PyYAML", 3, other),
      pyDep("pyyaml", 3, other),
    ]);
    assert.deepEqual(
      out.map((d) => d.declaredLine),
      [undefined, 3],
    );
  });

  it("normalises like PEP 503", () => {
    assert.equal(pep503("Typing__Extensions"), "typing-extensions");
    assert.equal(pep503("ruamel.yaml"), "ruamel-yaml");
    assert.equal(pep503("a-_.b"), "a-b");
  });
});
