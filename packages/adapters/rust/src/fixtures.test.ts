/**
 * Fixture-driven tests (#51): every fixtures/rust/<scenario> with
 * expectations in expected.json is checked against the real adapter.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { AdapterContext } from "@ghostdeps/core";
import { detectRust } from "./detect.js";
import { discoverCrates } from "./discover.js";
import { parseCargoManifest } from "./manifest.js";
import { FIXTURES_ROOT, fixtureHandle } from "./testing/fs-handle.js";

interface ExpectedFixture {
  detection?: { minConfidence?: number; maxConfidence?: number; projects?: string[] };
  dependencies?: { name: string; kind?: string; constraint?: string; declaredIn?: string }[];
  conditions?: { kind: string; statement: string }[];
  detectionEvidence?: string[];
}

const RUST_FIXTURES = path.join(FIXTURES_ROOT, "rust");
const scenarios = (await readdir(RUST_FIXTURES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("rust fixtures (#51)", () => {
  it("has the scenarios the issue asks for", () => {
    for (const name of ["single-crate", "workspace", "feature-conditional"]) {
      assert.ok(scenarios.includes(name), `missing fixture rust/${name}`);
    }
  });

  for (const scenario of scenarios) {
    it(`fixture rust/${scenario} matches its expected.json`, async () => {
      const expected = JSON.parse(
        await readFile(path.join(RUST_FIXTURES, scenario, "expected.json"), "utf8"),
      ) as ExpectedFixture;
      const context: AdapterContext = {
        repository: fixtureHandle("rust", scenario),
        network: { mode: "offline" },
      };
      const detection = await detectRust(context);

      if (expected.detection?.minConfidence !== undefined) {
        assert.ok(
          detection.confidence >= expected.detection.minConfidence,
          `${scenario}: confidence ${detection.confidence}`,
        );
      }
      if (expected.detection?.maxConfidence !== undefined) {
        assert.ok(
          detection.confidence <= expected.detection.maxConfidence,
          `${scenario}: confidence ${detection.confidence}`,
        );
      }
      if (expected.detection?.projects !== undefined) {
        assert.deepEqual(
          detection.projects.map((p) => p.path).sort(),
          [...expected.detection.projects].sort(),
        );
      }
      for (const kind of expected.detectionEvidence ?? []) {
        assert.ok(
          detection.evidence.some((e) => e.kind === kind),
          `${scenario}: no ${kind} evidence`,
        );
      }

      const { crates } = await discoverCrates(context);
      const parsed = crates
        .filter((c) => detection.projects.some((p) => p.path === c.project.path))
        .map((c) => parseCargoManifest(c.manifest, c.project, c.workspaceRoot));
      const deps = parsed.flatMap((r) => r.dependencies);
      if (expected.dependencies !== undefined) {
        assert.equal(
          deps.length,
          expected.dependencies.length,
          `${scenario}: ${JSON.stringify(deps.map((d) => d.name))}`,
        );
        for (const want of expected.dependencies) {
          const got = deps.find(
            (d) =>
              d.name === want.name &&
              (want.declaredIn === undefined || d.declaredIn === want.declaredIn),
          );
          assert.ok(got, `${scenario}: missing dependency ${want.name}`);
          if (want.kind !== undefined)
            assert.equal(got.kind, want.kind, `${scenario}: ${want.name} kind`);
          if (want.constraint !== undefined)
            assert.equal(got.constraint, want.constraint, `${scenario}: ${want.name} constraint`);
        }
      }
      if (expected.conditions !== undefined) {
        const conditions = parsed.flatMap((r) => r.conditions);
        assert.deepEqual(
          conditions.map((c) => `${c.kind}: ${c.statement}`).sort(),
          expected.conditions.map((c) => `${c.kind}: ${c.statement}`).sort(),
        );
      }
    });
  }
});
