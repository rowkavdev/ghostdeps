import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { analyseRepository } from "./analyse.js";
import { previewNpmRemoval } from "./fix-preview.js";
import { FsRepositoryHandle } from "./scanner/handle.js";
import { createDefaultPolicy } from "../recommend/policy.js";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/fix-evidence",
);
const project = {
  path: ".",
  ecosystem: "javascript-typescript",
  packageManagers: [{ name: "npm", lockfile: "package-lock.json" }],
};
function syntheticAdapter(used = false): EcosystemAdapter {
  return {
    ecosystem: "javascript-typescript",
    apiVersion: adapterApiVersion,
    capabilities: new Set(["usageAnalysis", "referenceAnalysis", "dependencyGraph"]),
    async detect() {
      return { confidence: 1, projects: [project], evidence: [] };
    },
    async listDirectDependencies(ctx) {
      const doc = JSON.parse(await ctx.repository.readFile("package.json"));
      return Object.entries(doc.dependencies ?? {}).map(([name, constraint]) => ({
        name,
        constraint: String(constraint),
        kind: "runtime" as const,
        project,
        declaredIn: "package.json",
      }));
    },
    async buildDependencyGraph(ctx) {
      const doc = JSON.parse(await ctx.repository.readFile("package-lock.json"));
      return [
        {
          project,
          nodes: Object.entries(doc.packages)
            .filter(([path]) => path !== "")
            .map(([path, value]) => ({
              name: path.slice("node_modules/".length),
              version: (value as { version: string }).version,
              dependencies: [],
              dev: false,
            })),
          transitiveClosure: {},
          incomplete: false,
        },
      ];
    },
    async findUsage() {
      return {
        usages: used
          ? [
              {
                dependency: "left-pad",
                file: "index.js",
                line: 1,
                form: "static" as const,
                symbols: [],
              },
            ]
          : [],
        referenceAnalysisComplete: true,
      };
    },
  };
}
async function openFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "gd-fix-evidence-"));
  await cp(join(fixtureRoot, name), root, { recursive: true });
  return { root, handle: await FsRepositoryHandle.open(root) };
}
async function bytes(root: string) {
  return Promise.all(
    ["package.json", "package-lock.json", "index.js"].map((name) => readFile(join(root, name))),
  );
}

describe("slice-2 evidence gate: executable dry-run fixtures", () => {
  it("eligible leaf is statically checked, preserves bytes, and has no sandbox claim", async () => {
    const { root, handle } = await openFixture("eligible");
    try {
      const before = await bytes(root);
      const preview = await previewNpmRemoval(handle, [syntheticAdapter()], "left-pad");
      assert.equal(preview.status, "statically-checked", preview.reason);
      assert.equal(preview.verification.sandbox, "not-run");
      assert.equal(preview.verification.static, "passed");
      assert.equal(preview.verification.lockfile, "passed");
      assert.deepEqual(
        preview.files?.map((file) => file.path),
        ["package.json", "package-lock.json"],
      );
      assert.deepEqual(await bytes(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("a changed source snapshot invalidates the prior finding key", async () => {
    const first = await openFixture("eligible");
    const second = await openFixture("stale-source");
    try {
      const old = await previewNpmRemoval(first.handle, [syntheticAdapter()], "left-pad");
      const current = await previewNpmRemoval(second.handle, [syntheticAdapter()], "left-pad");
      assert.equal(old.status, "statically-checked");
      assert.equal(current.status, "statically-checked");
      assert.notEqual(old.key, current.key);
      assert.deepEqual(current.files, old.files, "the source change is outside the edit targets");
    } finally {
      await rm(first.root, { recursive: true, force: true });
      await rm(second.root, { recursive: true, force: true });
    }
  });
  it("refuses a source change during static overlay rather than returning a stale edit", async () => {
    const { root, handle } = await openFixture("eligible");
    try {
      let graphCalls = 0;
      const base = syntheticAdapter();
      const race: EcosystemAdapter = {
        ...base,
        async buildDependencyGraph(ctx, projects) {
          if (++graphCalls === 2)
            await writeFile(join(root, "index.js"), "export const one = 2;\n");
          return base.buildDependencyGraph!(ctx, projects);
        },
      };
      const before = await Promise.all(
        ["package.json", "package-lock.json"].map((name) => readFile(join(root, name))),
      );
      const preview = await previewNpmRemoval(handle, [race], "left-pad");
      assert.equal(preview.status, "blocked");
      assert.match(preview.reason!, /Source snapshot changed/);
      assert.equal(preview.files, undefined);
      assert.deepEqual(
        await Promise.all(
          ["package.json", "package-lock.json"].map((name) => readFile(join(root, name))),
        ),
        before,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refused .npmrc edit leaves bytes untouched while read-only analysis remains available", async () => {
    const { root, handle } = await openFixture("declined");
    try {
      const before = await bytes(root);
      const preview = await previewNpmRemoval(handle, [syntheticAdapter()], "left-pad");
      assert.equal(preview.status, "blocked");
      assert.match(preview.reason!, /npm configuration/);
      assert.equal(preview.diff, undefined);
      assert.deepEqual(await bytes(root), before);
      const result = await analyseRepository(handle, {
        adapters: [syntheticAdapter()],
        network: { mode: "offline" },
        recommend: createDefaultPolicy(),
      });
      assert.ok(
        result.dependencies.some((d) => d.name === "left-pad"),
        "declining a fix must not disable read-only scan results",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("re-running eligibility on the same bytes rejects a newly observed use", async () => {
    const { root, handle } = await openFixture("usage-revalidated");
    try {
      const before = await bytes(root);
      const old = await previewNpmRemoval(handle, [syntheticAdapter()], "left-pad");
      const current = await previewNpmRemoval(handle, [syntheticAdapter(true)], "left-pad");
      assert.equal(old.status, "statically-checked");
      assert.equal(current.status, "blocked");
      assert.match(current.reason!, /unused/);
      assert.equal(current.key, undefined);
      assert.deepEqual(await bytes(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
