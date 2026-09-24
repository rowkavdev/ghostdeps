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
import { createPythonAdapter } from "./adapter.js";
import { detectPython } from "./detect.js";
import { ImportResolver, firstPartyModules, readTopLevelMetadata } from "./import-map.js";
import { FIXTURES_ROOT, fixtureHandle } from "./testing/fs-handle.js";

interface ExpectedDependency {
  name: string;
  kind?: string;
  constraint?: string;
  declaredIn?: string;
}

interface ExpectedGraph {
  incomplete?: boolean;
  /** Direct dependency -> size of its transitive closure. */
  transitiveCounts?: Record<string, number>;
  /** Exactly the nodes flagged dev, sorted. */
  devNodes?: string[];
  /** Exactly the graph's nodes, sorted. */
  nodes?: string[];
}

/** Import resolution expectation: "stdlib", "first-party", "unresolved" or a distribution name. */
type ExpectedImports = Record<string, Record<string, string>>;

interface ExpectedFixture {
  dependencies?: ExpectedDependency[];
  /** Project root -> import path -> expected resolution (#46). */
  imports?: ExpectedImports;
  graph?: Record<string, ExpectedGraph>;
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

      if (expected.dependencies !== undefined) {
        const adapter = createPythonAdapter();
        const detection = await adapter.detect(context);
        const actual = await adapter.listDirectDependencies(context, detection.projects);
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

      if (expected.imports !== undefined) {
        const adapter = createPythonAdapter();
        const detection = await adapter.detect(context);
        const deps = await adapter.listDirectDependencies(context, detection.projects);
        const files = await context.repository.listFiles();
        for (const [root, cases] of Object.entries(expected.imports)) {
          const resolver = new ImportResolver({
            declared: deps
              .filter((dep) => dep.declaredIn.startsWith(root === "." ? "" : `${root}/`))
              .map((dep) => dep.name),
            firstParty: firstPartyModules(root, files),
            topLevel: await readTopLevelMetadata(context.repository, root, files),
          });
          for (const [importPath, want] of Object.entries(cases)) {
            const got = resolver.resolve(importPath);
            const actual = got.kind === "dependency" ? got.distribution : got.kind;
            assert.equal(actual, want, `${scenario}: ${root} import ${importPath}`);
          }
        }
      }

      if (expected.graph !== undefined) {
        const adapter = createPythonAdapter();
        const detection = await adapter.detect(context);
        const graphs = await adapter.buildDependencyGraph!(context, detection.projects);
        for (const [root, want] of Object.entries(expected.graph)) {
          const graph = graphs.find((candidate) => candidate.project.path === root);
          assert.ok(graph, `${scenario}: no graph for ${root}`);
          if (want.incomplete !== undefined) {
            assert.equal(graph.incomplete, want.incomplete, `${scenario}: ${root} incomplete`);
          }
          for (const [dep, count] of Object.entries(want.transitiveCounts ?? {})) {
            assert.equal(
              graph.transitiveClosure[dep]?.length,
              count,
              `${scenario}: ${root} transitive count for ${dep}`,
            );
          }
          if (want.nodes !== undefined) {
            assert.deepEqual(
              graph.nodes.map((node) => node.name).sort(),
              want.nodes,
              `${scenario}: ${root} nodes`,
            );
          }
          if (want.devNodes !== undefined) {
            assert.deepEqual(
              graph.nodes
                .filter((node) => node.dev)
                .map((node) => node.name)
                .sort(),
              want.devNodes,
              `${scenario}: ${root} dev nodes`,
            );
          }
        }
      }
    });
  }
});
