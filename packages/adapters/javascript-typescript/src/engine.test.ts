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
import { fixtureHandle } from "./testing/fs-handle.js";

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
    assert.equal(hits[0]!.confidence, "high");
  });

  it("script-only and config-only dependencies are never unused", async () => {
    assert.deepEqual(unused(await findings("refs-script-only"), "typescript"), []);
    const config = await findings("refs-config-only");
    assert.deepEqual(unused(config, "eslint-plugin-import"), []);
    assert.deepEqual(unused(config, "@types/node"), []);
  });

  for (const [fixture, dependency] of [
    ["usage-dynamic", "plugin-a"],
    ["refs-partial-js-config", "eslint-plugin-foo"],
    ["refs-pnpm-bin-mismatch", "npm-check-updates"],
  ] as const) {
    it(`partial analysis (${fixture}): ${dependency} is not reported unused`, async () => {
      assert.deepEqual(unused(await findings(fixture), dependency), []);
    });
  }
});
