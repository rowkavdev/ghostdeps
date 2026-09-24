/**
 * Fixture-driven tests (issue #30): every fixtures/js/<scenario> directory
 * with detection/dependency expectations in expected.json is checked against
 * the real adapter. Findings blocks are data for later engine stages (#28,
 * #56) and are not asserted here yet.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { AdapterContext } from "@ghostdeps/core";
import { detectJavaScriptTypeScript } from "./detect.js";
import { parseManifest } from "./manifest.js";
import { FIXTURES_ROOT, fixtureHandle } from "./testing/fs-handle.js";

interface ExpectedDependency {
  name: string;
  kind?: string;
  constraint?: string;
  declaredIn?: string;
}

interface ExpectedFixture {
  description?: string;
  detection?: { minConfidence?: number; maxConfidence?: number; projects?: string[] };
  dependencies?: ExpectedDependency[];
}

async function loadExpected(dir: string): Promise<ExpectedFixture | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, "expected.json"), "utf8")) as ExpectedFixture;
  } catch {
    return undefined;
  }
}

const JS_FIXTURES = path.join(FIXTURES_ROOT, "js");
const scenarioDirs = (await readdir(JS_FIXTURES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("js fixtures (issue #30)", () => {
  for (const scenario of scenarioDirs) {
    it(`fixture js/${scenario} matches its expected.json`, async () => {
      const expected = await loadExpected(path.join(JS_FIXTURES, scenario));
      assert.ok(expected, `${scenario}: expected.json missing or unreadable`);
      const repository = fixtureHandle("js", scenario);
      const context: AdapterContext = { repository, network: { mode: "offline" } };

      if (expected.detection !== undefined) {
        const detection = await detectJavaScriptTypeScript(context);
        if (expected.detection.minConfidence !== undefined) {
          assert.ok(
            detection.confidence >= expected.detection.minConfidence,
            `${scenario}: confidence ${detection.confidence} below expected minimum ${expected.detection.minConfidence}`,
          );
        }
        if (expected.detection.maxConfidence !== undefined) {
          assert.ok(
            detection.confidence <= expected.detection.maxConfidence,
            `${scenario}: confidence ${detection.confidence} above expected maximum ${expected.detection.maxConfidence}`,
          );
        }
        if (expected.detection.projects !== undefined) {
          assert.deepEqual(
            detection.projects.map((project) => project.path).sort(),
            [...expected.detection.projects].sort(),
            `${scenario}: detected project roots differ`,
          );
        }
      }

      if (expected.dependencies !== undefined) {
        const detection = await detectJavaScriptTypeScript(context);
        const parsed = await Promise.all(
          detection.projects.map((project) => parseManifest(repository, project)),
        );
        const actual = parsed.flatMap((result) => result.dependencies);
        for (const want of expected.dependencies) {
          const found = actual.find((dep) => dep.name === want.name);
          assert.ok(found, `${scenario}: dependency ${want.name} not parsed`);
          if (want.kind !== undefined)
            assert.equal(found.kind, want.kind, `${scenario}: ${want.name} kind`);
          if (want.constraint !== undefined)
            assert.equal(found.constraint, want.constraint, `${scenario}: ${want.name} constraint`);
          if (want.declaredIn !== undefined)
            assert.equal(found.declaredIn, want.declaredIn, `${scenario}: ${want.name} declaredIn`);
        }
        if (expected.dependencies.length === 0) {
          assert.deepEqual(actual, [], `${scenario}: expected no parsed dependencies`);
        }
      }
    });
  }
});
