/**
 * Engine-level tests (#138): the real JS/TS adapter through analyseRepository
 * and the default recommendation policy, over real fixtures. "unused" may
 * only appear when usage and reference analysis actually completed for the
 * project; any limitation (unresolved dynamic import, JS config that is never
 * evaluated, a script bin that can't be matched) keeps it out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyseRepository, defaultPolicy } from "@ghostdeps/core";
import type { Finding } from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "./adapter.js";
import { fixtureHandle, memoryHandle } from "./testing/fs-handle.js";

async function findings(fixture: string): Promise<Finding[]> {
  const result = await analyseRepository(fixtureHandle("js", fixture), {
    adapters: [createJavaScriptTypeScriptAdapter()],
    recommend: defaultPolicy,
  });
  return result.findings;
}

const unused = (all: Finding[], dependency: string) =>
  all.filter((f) => f.kind === "unused" && f.dependency === dependency);

describe("JS adapter through the engine and default policy (#138)", () => {
  it("complete analysis: a dependency with no evidence anywhere is reported unused", async () => {
    const hits = unused(await findings("basic-unused"), "left-pad");
    assert.equal(hits.length, 1);
    // Medium, not high: core caps unused confidence until the corpus check greens (#178).
    assert.equal(hits[0]!.confidence, "medium");
  });

  it("script-only and config-only dependencies are never unused", async () => {
    assert.deepEqual(unused(await findings("refs-script-only"), "typescript"), []);
    const config = await findings("refs-config-only");
    assert.deepEqual(unused(config, "eslint-plugin-import"), []);
    assert.deepEqual(unused(config, "@types/node"), []);
  });

  for (const [fixture, dependency] of [
    ["refs-concurrently-args", "autocannon"],
    ["refs-script-flag-value", "@jsumners/line-reporter"],
    ["refs-script-flag-value", "tsx"],
    ["refs-nested-tsconfig", "fastify-tsconfig"],
    ["refs-workflow-only", "publint"],
    ["convention-simple-git-hooks-key", "simple-git-hooks"],
    ["convention-size-limit-preset", "@size-limit/preset-small-lib"],
    ["refs-html-module-script", "vuex"],
    ["refs-html-module-script", "normalize.css"],
    ["refs-vue-sfc", "@iconify/vue"],
    ["refs-root-dep-from-member", "execa"],
    ["refs-create-require", "core-js"],
    ["refs-create-require", "@types/pnpapi"],
    ["refs-string-specifier", "regenerator-runtime"],
    ["refs-string-specifier", "systemjs"],
    ["convention-css-preprocessor-ext", "sugarss"],
    ["convention-css-preprocessor-ext", "sass"],
  ] as const) {
    it(`real-repo regression (${fixture}): ${dependency} is not reported unused`, async () => {
      assert.deepEqual(unused(await findings(fixture), dependency), []);
    });
  }

  for (const [fixture, dependency] of [
    ["usage-dynamic", "plugin-a"],
    ["refs-partial-js-config", "eslint-plugin-foo"],
    ["refs-pnpm-bin-mismatch", "npm-check-updates"],
    ["refs-shared-config-no-lockfile", "globals"],
    ["refs-shared-config-no-lockfile", "eslint-import-resolver-typescript"],
    ["refs-shared-config-lockfile", "globals"],
    ["refs-shared-config-lockfile", "eslint-import-resolver-typescript"],
  ] as const) {
    it(`partial analysis (${fixture}): ${dependency} is not reported unused`, async () => {
      assert.deepEqual(unused(await findings(fixture), dependency), []);
    });
  }
});

describe("PR mode: removed-last-usage through the real adapter (#168)", () => {
  it("reports the dependency whose last import the PR removed, and only that one", async () => {
    const repo = memoryHandle({
      "package.json": JSON.stringify({
        name: "pr-fixture",
        version: "0.0.0",
        dependencies: { dropped: "^1.0.0", kept: "^1.0.0" },
      }),
      "src/a.ts": `import k from "kept";\nexport const v = k;\n`,
    });
    const result = await analyseRepository(repo, {
      adapters: [createJavaScriptTypeScriptAdapter()],
      recommend: defaultPolicy,
      pullRequestChanges: [],
      pullRequestSourceChanges: [
        {
          path: "src/a.ts",
          removedLines: [
            { line: 1, text: `import d from "dropped";` },
            { line: 2, text: `import k from "kept";` },
          ],
          addedLines: [{ line: 1, text: `import k from "kept";` }],
        },
      ],
    });
    const verdicts = result.findings.filter((f) => f.kind === "unused");
    assert.deepEqual(
      verdicts.map((f) => [f.rule, f.dependency]),
      [["removed-last-usage", "dropped"]],
    );
    assert.ok(
      verdicts[0]!.evidence.some(
        (e) => e.kind === "usage-removed-in-pr" && e.file === "src/a.ts" && e.line === 1,
      ),
    );
    assert.ok(!result.findings.some((f) => f.kind === "unused" && f.dependency === "kept"));
  });
});
