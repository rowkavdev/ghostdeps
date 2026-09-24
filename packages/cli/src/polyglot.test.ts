import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { analyseDirectory, createDefaultPolicy, renderJsonReport } from "@ghostdeps/core";
import { defaultAdapters } from "./adapters.js";

/** Tests run from packages/cli/dist. */
const FIXTURE = "../../../fixtures/polyglot/js-app-python-service";
const fixture = fileURLToPath(new URL(FIXTURE, import.meta.url));
const expected = JSON.parse(
  readFileSync(new URL(`${FIXTURE}/expected.json`, import.meta.url), "utf8"),
) as {
  projectTree: { id: string; parent?: string }[];
  graphEcosystems: string[];
  findings: { rule: string; dependency: string; kind: string }[];
  mustNotFind: { rule: string }[];
};
const golden = new URL("../test/golden/scan-polyglot-js-app-python-service.json", import.meta.url);

// Multi-ecosystem mechanics (#55) through the shipped adapters: the real JS
// adapter and the real Python adapter. The test-only stub that stood in for
// Python before the adapter landed has been removed.
const analyse = () =>
  analyseDirectory(fixture, {
    adapters: defaultAdapters(),
    network: { mode: "offline" },
    recommend: createDefaultPolicy({}),
  });

describe("polyglot fixture: one unified result (#55)", () => {
  it("ships exactly one Python adapter, the real one", () => {
    const python = defaultAdapters().filter((adapter) => adapter.ecosystem === "python");
    assert.equal(python.length, 1);
    assert.ok(python[0]!.capabilities.has("dependencyGraph"));
  });

  it("yields one project tree, one graph and cross-ecosystem overlap notes", async () => {
    const result = await analyse();
    assert.deepEqual(
      result.projectTree?.map((n) => (n.parent ? { id: n.id, parent: n.parent } : { id: n.id })),
      expected.projectTree,
    );
    assert.deepEqual(
      result.graph?.ecosystems.map((e) => e.ecosystem),
      expected.graphEcosystems,
    );
    assert.ok(result.graph?.ecosystems.every((e) => e.graphs === "complete"));
    for (const want of expected.findings) {
      assert.ok(
        result.findings.some(
          (f) => f.rule === want.rule && f.dependency === want.dependency && f.kind === want.kind,
        ),
        `missing ${want.rule} on ${want.dependency}`,
      );
    }
    for (const never of expected.mustNotFind) {
      assert.ok(!result.findings.some((f) => f.rule === never.rule), `unexpected ${never.rule}`);
    }

    const text = renderJsonReport(result);
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, text);
    assert.equal(text, readFileSync(golden, "utf8"));
  });
});
