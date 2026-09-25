import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { FsRepositoryHandle } from "./scanner/handle.js";
import { previewNpmRemoval } from "./fix-preview.js";

const project = {
  path: ".",
  ecosystem: "javascript-typescript",
  packageManagers: [{ name: "npm", lockfile: "package-lock.json" }],
};
const adapter: EcosystemAdapter = {
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
    return { usages: [], referenceAnalysisComplete: true };
  },
};
const manifest = {
  name: "fixture",
  version: "1.0.0",
  packageManager: "npm@10.8.0",
  dependencies: { "left-pad": "^1.3.0" },
};
const lock = (version: 2 | 3) => ({
  name: "fixture",
  version: "1.0.0",
  lockfileVersion: version,
  packages: {
    "": { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } },
    "node_modules/left-pad": { version: "1.3.0" },
  },
  ...(version === 2 ? { dependencies: { "left-pad": { version: "1.3.0" } } } : {}),
});
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function fixture(version: 2 | 3) {
  const root = await mkdtemp(join(tmpdir(), "gd-fix-preview-"));
  await writeFile(
    join(root, "package.json"),
    text({ ...manifest, packageManager: version === 2 ? "npm@8.19.4" : "npm@10.8.0" }),
  );
  await writeFile(join(root, "package-lock.json"), text(lock(version)));
  await writeFile(join(root, "index.js"), "export const one = 1;\n");
  return { root, handle: await FsRepositoryHandle.open(root) };
}

describe("npm removal preview (#389)", () => {
  for (const version of [2, 3] as const) {
    it(`proposes an exact, read-only leaf removal in npm v${version}`, async () => {
      const { root, handle } = await fixture(version);
      try {
        const before = await Promise.all(
          ["package.json", "package-lock.json"].map((p) => readFile(join(root, p), "utf8")),
        );
        const result = await previewNpmRemoval(handle, [adapter], "left-pad");
        assert.equal(result.status, "statically-checked", result.reason);
        assert.equal(result.verification.sandbox, "not-run");
        assert.match(result.diff!, /--- a\/package-lock.json/);
        assert.match(result.diff!, /node_modules\/left-pad/);
        assert.equal(result.files?.length, 2);
        assert.deepEqual(
          await Promise.all(
            ["package.json", "package-lock.json"].map((p) => readFile(join(root, p), "utf8")),
          ),
          before,
        );
        assert.deepEqual(await previewNpmRemoval(handle, [adapter], "left-pad"), result);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
  it("refuses v1, nested packages, incomplete scan and unsupported manager visibly", async () => {
    const { root, handle } = await fixture(3);
    try {
      await writeFile(join(root, "package-lock.json"), text({ ...lock(3), lockfileVersion: 1 }));
      assert.match(
        (await previewNpmRemoval(await FsRepositoryHandle.open(root), [adapter], "left-pad"))
          .reason!,
        /lockfileVersion 2 or 3/,
      );
      await writeFile(
        join(root, "package-lock.json"),
        text({
          ...lock(3),
          packages: {
            ...lock(3).packages,
            "node_modules/left-pad/node_modules/child": { version: "1" },
          },
        }),
      );
      assert.match(
        (await previewNpmRemoval(await FsRepositoryHandle.open(root), [adapter], "left-pad"))
          .reason!,
        /Nested.*packages|Nested or nonstandard/,
      );
      assert.match(
        (
          await previewNpmRemoval(
            new FsRepositoryHandle({ ...handle.scan, truncated: "max-files" }),
            [adapter],
            "left-pad",
          )
        ).reason!,
        /incomplete/,
      );
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      assert.match(
        (await previewNpmRemoval(await FsRepositoryHandle.open(root), [adapter], "left-pad"))
          .reason!,
        /Another package manager/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses when complete reference proof or verdict is absent", async () => {
    const { root, handle } = await fixture(3);
    try {
      const missingProof = { ...adapter, capabilities: new Set(["usageAnalysis" as const]) };
      assert.match(
        (await previewNpmRemoval(handle, [missingProof], "left-pad")).reason!,
        /Complete source/,
      );
      const used: EcosystemAdapter = {
        ...adapter,
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
            usages: [
              { dependency: "left-pad", file: "index.js", line: 1, form: "static", symbols: [] },
            ],
            referenceAnalysisComplete: true,
          };
        },
      };
      assert.match((await previewNpmRemoval(handle, [used], "left-pad")).reason!, /unused/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects stale root, v2 mismatch, transitive consumer, and npm pin mismatch", async () => {
    const { root } = await fixture(2);
    try {
      const check = async () =>
        (await previewNpmRemoval(await FsRepositoryHandle.open(root), [adapter], "left-pad"))
          .reason!;
      await writeFile(join(root, "package-lock.json"), text({ ...lock(2), version: "2.0.0" }));
      assert.match(await check(), /root identity/);
      await writeFile(
        join(root, "package-lock.json"),
        text({ ...lock(2), dependencies: { "left-pad": { version: "1.2.0" } } }),
      );
      assert.match(await check(), /v2 legacy/);
      await writeFile(
        join(root, "package-lock.json"),
        text({
          ...lock(2),
          packages: {
            ...lock(2).packages,
            "node_modules/foo": { version: "2.0.0", dependencies: { "left-pad": "^1.3.0" } },
          },
          dependencies: {
            ...lock(2).dependencies,
            foo: { version: "2.0.0", requires: { "left-pad": "^1.3.0" } },
          },
        }),
      );
      assert.match(await check(), /references this dependency/);
      await writeFile(join(root, "package-lock.json"), text(lock(2)));
      await writeFile(
        join(root, "package.json"),
        text({ ...manifest, packageManager: "npm@10.8.0" }),
      );
      assert.match(await check(), /supported pair/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses control display, lifecycle script, unknown schema and incomplete graph", async () => {
    const { root } = await fixture(3);
    try {
      const check = async (a: EcosystemAdapter = adapter) =>
        (await previewNpmRemoval(await FsRepositoryHandle.open(root), [a], "left-pad")).reason!;
      await writeFile(join(root, "package.json"), text({ ...manifest, name: "fixture\u202e" }));
      assert.match(await check(), /bidirectional/);
      await writeFile(join(root, "package.json"), text(manifest));
      await writeFile(
        join(root, "package-lock.json"),
        text({
          ...lock(3),
          packages: {
            ...lock(3).packages,
            "node_modules/left-pad": { version: "1.3.0", hasInstallScript: true },
          },
        }),
      );
      assert.match(await check(), /lifecycle script/);
      await writeFile(
        join(root, "package-lock.json"),
        text({
          ...lock(3),
          packages: {
            ...lock(3).packages,
            "node_modules/left-pad": { version: "1.3.0", unknownField: true },
          },
        }),
      );
      assert.match(await check(), /Unsupported target/);
      await writeFile(join(root, "package-lock.json"), text(lock(3)));
      const partial: EcosystemAdapter = {
        ...adapter,
        async buildDependencyGraph(ctx) {
          const graphs = await adapter.buildDependencyGraph!(ctx, [project]);
          return graphs.map((g) => ({ ...g, incomplete: true }));
        },
      };
      assert.match(await check(partial), /incomplete/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses source mutation during overlay analysis and binds key to source bytes", async () => {
    const { root, handle } = await fixture(3);
    try {
      const first = await previewNpmRemoval(handle, [adapter], "left-pad");
      assert.equal(first.status, "statically-checked");
      await writeFile(join(root, "index.js"), "export const two = 2;\n");
      const second = await previewNpmRemoval(
        await FsRepositoryHandle.open(root),
        [adapter],
        "left-pad",
      );
      assert.equal(second.status, "statically-checked");
      assert.notEqual(first.key, second.key);
      let calls = 0;
      const racy: EcosystemAdapter = {
        ...adapter,
        async buildDependencyGraph(ctx) {
          if (++calls === 2) await writeFile(join(root, "index.js"), "export const three = 3;\n");
          return adapter.buildDependencyGraph!(ctx, [project]);
        },
      };
      const result = await previewNpmRemoval(
        await FsRepositoryHandle.open(root),
        [racy],
        "left-pad",
      );
      assert.equal(result.status, "blocked");
      assert.match(result.reason!, /Source snapshot changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses an added source path during overlay analysis", async () => {
    const { root, handle } = await fixture(3);
    try {
      let calls = 0;
      const racy: EcosystemAdapter = {
        ...adapter,
        async buildDependencyGraph(ctx) {
          if (++calls === 2) await writeFile(join(root, "extra.js"), "export const extra = 1;\n");
          return adapter.buildDependencyGraph!(ctx, [project]);
        },
      };
      const result = await previewNpmRemoval(handle, [racy], "left-pad");
      assert.equal(result.status, "blocked");
      assert.match(result.reason!, /Source snapshot changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses hardlink aliases for either edit target", async () => {
    const { root, handle } = await fixture(3);
    try {
      await link(join(root, "package.json"), join(root, "alias.json"));
      const result = await previewNpmRemoval(handle, [adapter], "left-pad");
      assert.equal(result.status, "blocked");
      assert.match(result.reason!, /Hardlink aliases/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses a C1 control embedded in displayed root metadata", async () => {
    const { root } = await fixture(3);
    try {
      await writeFile(join(root, "package.json"), text({ ...manifest, name: "f\u009b" }));
      const result = await previewNpmRemoval(
        await FsRepositoryHandle.open(root),
        [adapter],
        "left-pad",
      );
      assert.equal(result.status, "blocked");
      assert.match(result.reason!, /Control or bidirectional/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
