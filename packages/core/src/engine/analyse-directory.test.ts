import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { analyseDirectory } from "./analyse-directory.js";

// dist/engine -> repository root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const manifestAdapter: EcosystemAdapter = {
  ecosystem: "javascript-typescript",
  apiVersion: adapterApiVersion,
  capabilities: new Set(),
  async detect(ctx) {
    const found = await ctx.repository.exists("package.json");
    return {
      confidence: found ? 1 : 0,
      projects: found
        ? [{ path: ".", ecosystem: "javascript-typescript", packageManagers: [] }]
        : [],
      evidence: found
        ? [{ kind: "manifest-found", statement: "package.json", file: "package.json" }]
        : [],
    };
  },
  async listDirectDependencies(ctx, projects) {
    const manifest = JSON.parse(await ctx.repository.readFile("package.json")) as {
      dependencies?: Record<string, string>;
    };
    return Object.entries(manifest.dependencies ?? {}).map(([name, constraint]) => ({
      name,
      constraint,
      kind: "runtime" as const,
      project: projects[0]!,
      declaredIn: "package.json",
    }));
  },
};

describe("analyseDirectory", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ghostdeps-analyse-dir-"));
    await writeFile(path.join(root, "package.json"), '{"dependencies":{"leftpad":"^1.0.0"}}');
    await mkdir(path.join(root, "src"));
    for (let i = 0; i < 5; i += 1) await writeFile(path.join(root, `src/f${i}.js`), "x");
    await writeFile(path.join(root, "src/huge.js"), "x".repeat(500));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scans and analyses a fixture with no incompleteness notes", async () => {
    const result = await analyseDirectory(path.join(repoRoot, "fixtures/js/basic-unused"), {
      adapters: [manifestAdapter],
    });
    assert.ok(result.dependencies.length > 0);
    assert.deepEqual(
      result.findings.filter((f) => f.kind === "info"),
      [],
    );
  });

  it("reports oversized files as an info finding with examples", async () => {
    const result = await analyseDirectory(root, {
      adapters: [manifestAdapter],
      scan: { limits: { maxFileBytes: 100 } },
    });
    const note = result.findings.find((f) => f.summary.includes("over the size ceiling"));
    assert.ok(note);
    assert.deepEqual(note.affectedFiles, ["src/huge.js"]);
    assert.equal(note.evidence[0]?.file, "src/huge.js");
  });

  it("never reports high-confidence unused when the only usage is in an unscanned file", async () => {
    await writeFile(path.join(root, "src/huge.js"), `require("leftpad");\n${"x".repeat(500)}`);
    const withUsage: EcosystemAdapter = {
      ...manifestAdapter,
      capabilities: new Set(["usageAnalysis"]),
      async findUsage(ctx, dep) {
        const usages = [];
        for (const file of await ctx.repository.listFiles()) {
          if (!file.endsWith(".js")) continue;
          if ((await ctx.repository.readFile(file)).includes(`require("${dep.name}")`)) {
            usages.push({
              dependency: dep.name,
              file,
              line: 1,
              form: "require" as const,
              symbols: [],
            });
          }
        }
        return usages;
      },
    };
    const result = await analyseDirectory(root, {
      adapters: [withUsage],
      scan: { limits: { maxFileBytes: 100 } },
      recommend: ({ dependencies, usages }) =>
        dependencies
          .filter((d) => !usages.some((u) => u.dependency === d.name))
          .map((d) => ({
            kind: "unused" as const,
            dependency: d.name,
            summary: `${d.name} is never imported`,
            recommendation: "Remove it.",
            evidence: [{ kind: "no-import-found", statement: "no imports" }],
            confidence: "high" as const,
            limitations: [],
            affectedFiles: [d.declaredIn],
          })),
    });
    const unused = result.findings.find((f) => f.kind === "unused" && f.dependency === "leftpad");
    assert.ok(unused, "the policy still reports it, since usage is invisible");
    assert.equal(unused.confidence, "medium");
    assert.ok(unused.limitations.some((l) => l.includes("scan was incomplete")));
  });

  it("uses the right noun per skip reason", async () => {
    const deep = await analyseDirectory(root, {
      adapters: [manifestAdapter],
      scan: { limits: { maxDepth: 0 } },
    });
    assert.ok(
      deep.findings.some((f) => f.summary === "1 directory nested too deeply not analysed"),
    );
    const large = await analyseDirectory(root, {
      adapters: [manifestAdapter],
      scan: { limits: { maxFileBytes: 100 } },
    });
    assert.ok(
      large.findings.some((f) => f.summary === "1 file over the size ceiling not analysed"),
    );
  });

  it("reports a truncated scan so a partial result is never presented as complete", async () => {
    const result = await analyseDirectory(root, {
      adapters: [manifestAdapter],
      scan: { limits: { maxFiles: 3 } },
    });
    const note = result.findings.find((f) => f.evidence[0]?.kind === "scan-truncated");
    assert.ok(note);
    assert.match(note.summary, /max-files/);
    assert.ok(note.limitations.length > 0);
  });
});
