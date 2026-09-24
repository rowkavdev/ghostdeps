/**
 * Fixture-driven tests (issue #48): every fixtures/python/<scenario>
 * directory is checked against the real adapter using the machine-checkable
 * blocks in its expected.json. Findings blocks are data for later engine
 * stages and are not asserted here.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { AdapterContext } from "@ghostdeps/core";
import { detectPython } from "./detect.js";
import { FIXTURES_ROOT, fixtureHandle } from "./testing/fs-handle.js";

interface ExpectedFixture {
  description?: string;
  detection?: {
    minConfidence?: number;
    maxConfidence?: number;
    projects?: string[];
    packageManagers?: Record<string, string[]>;
  };
}

const PY_FIXTURES = path.join(FIXTURES_ROOT, "python");
const scenarioDirs = (await readdir(PY_FIXTURES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("python fixtures (issue #48)", () => {
  it("has scenarios to check", () => {
    assert.ok(scenarioDirs.length > 0);
  });

  for (const scenario of scenarioDirs) {
    it(`fixture python/${scenario} matches its expected.json`, async () => {
      const expected = JSON.parse(
        await readFile(path.join(PY_FIXTURES, scenario, "expected.json"), "utf8"),
      ) as ExpectedFixture;
      assert.ok(expected.description, `${scenario}: expected.json needs a description`);
      const context: AdapterContext = {
        repository: fixtureHandle("python", scenario),
        network: { mode: "offline" },
      };

      if (expected.detection !== undefined) {
        const detection = await detectPython(context);
        const { minConfidence, maxConfidence, projects, packageManagers } = expected.detection;
        if (minConfidence !== undefined) {
          assert.ok(
            detection.confidence >= minConfidence,
            `${scenario}: confidence ${detection.confidence} below ${minConfidence}`,
          );
        }
        if (maxConfidence !== undefined) {
          assert.ok(
            detection.confidence <= maxConfidence,
            `${scenario}: confidence ${detection.confidence} above ${maxConfidence}`,
          );
        }
        if (projects !== undefined) {
          assert.deepEqual(
            detection.projects.map((project) => project.path).sort(),
            [...projects].sort(),
            `${scenario}: detected project roots`,
          );
        }
        for (const [root, managers] of Object.entries(packageManagers ?? {})) {
          const project = detection.projects.find((candidate) => candidate.path === root);
          assert.ok(project, `${scenario}: no project at ${root}`);
          assert.deepEqual(
            project.packageManagers.map((manager) => manager.name),
            managers,
            `${scenario}: package managers at ${root}`,
          );
        }
      }
    });
  }
});
