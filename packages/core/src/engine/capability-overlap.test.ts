import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_CATALOGUE_VERSION,
  catalogueName,
} from "../capabilities/index.js";
import type { Dependency, ProjectRef } from "../types/index.js";
import { assembleAnalysisResult } from "./analyse.js";
import { crossEcosystemOverlaps, CROSS_ECOSYSTEM_OVERLAP_RULE } from "./capability-overlap.js";
import type { AdapterOutcome } from "./run-adapter.js";

const JS = "javascript-typescript";
const PY = "python";
const project = (ecosystem: string, path: string): ProjectRef => ({
  ecosystem,
  path,
  packageManagers: [],
});
const web = project(JS, "apps/web");
const svc = project(PY, "services/api");
const dep = (p: ProjectRef, name: string, declaredIn = `${p.path}/manifest`): Dependency => ({
  name,
  constraint: "*",
  kind: "runtime",
  project: p,
  declaredIn,
});

describe("capability catalogue (#55)", () => {
  it("is versioned data with unique cluster ids and members", () => {
    assert.equal(CAPABILITY_CATALOGUE.version, CAPABILITY_CATALOGUE_VERSION);
    const ids = CAPABILITY_CATALOGUE.clusters.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    const members = CAPABILITY_CATALOGUE.clusters.flatMap((c) =>
      c.members.map((m) => `${m.ecosystem}:${catalogueName(m.ecosystem, m.name)}`),
    );
    assert.equal(new Set(members).size, members.length, "a package sits in one cluster only");
    for (const c of CAPABILITY_CATALOGUE.clusters) {
      assert.ok(c.label.length > 0 && c.members.length > 1, c.id);
    }
  });

  it("matches Python names per PEP 503 and other names exactly", () => {
    assert.equal(catalogueName(PY, "PyYAML"), "pyyaml");
    assert.equal(catalogueName(PY, "ruamel.yaml"), "ruamel-yaml");
    assert.equal(catalogueName(PY, "Python_DateUtil"), "python-dateutil");
    assert.equal(catalogueName(JS, "Axios"), "Axios");
  });
});

describe("crossEcosystemOverlaps (#55)", () => {
  it("reports each declared package once, naming the other ecosystems' packages", () => {
    const findings = crossEcosystemOverlaps([
      dep(web, "axios"),
      dep(project(JS, "apps/admin"), "axios", "apps/admin/package.json"),
      dep(web, "got"),
      dep(svc, "Requests"),
      dep(web, "react"),
    ]);
    assert.deepEqual(
      findings.map((f) => [f.dependency, f.summary]),
      [
        [
          "axios",
          "axios (javascript-typescript) covers the same capability (HTTP client) as Requests (python)",
        ],
        [
          "got",
          "got (javascript-typescript) covers the same capability (HTTP client) as Requests (python)",
        ],
        [
          "Requests",
          "Requests (python) covers the same capability (HTTP client) as axios, got (javascript-typescript)",
        ],
      ],
    );
    for (const f of findings) {
      assert.equal(f.kind, "info");
      assert.equal(f.rule, CROSS_ECOSYSTEM_OVERLAP_RULE);
      assert.ok(f.dependency, "never a run note (#197)");
      assert.equal(f.awareness, true, "awareness only (#234)");
    }
    assert.deepEqual(findings[0]!.affectedFiles, ["apps/admin/package.json", "apps/web/manifest"]);
  });

  it("skips clusters marked crossEcosystem: false, like test runners (#211)", () => {
    const testRunner = CAPABILITY_CATALOGUE.clusters.find((c) => c.id === "test-runner");
    assert.equal(testRunner?.crossEcosystem, false, "kept in the catalogue for #58");
    assert.deepEqual(crossEcosystemOverlaps([dep(web, "vitest"), dep(svc, "pytest")]), []);
    // Other clusters still report.
    assert.equal(crossEcosystemOverlaps([dep(web, "zod"), dep(svc, "pydantic")]).length, 2);
  });

  it("stays quiet within one ecosystem (that is #58's job)", () => {
    assert.deepEqual(crossEcosystemOverlaps([dep(web, "axios"), dep(web, "got")]), []);
  });

  it("in a pull request reports only packages the PR added", () => {
    const deps = [dep(web, "axios"), dep(svc, "requests")];
    const added = [
      {
        change: "added" as const,
        name: "requests",
        ecosystem: PY,
        manifest: "services/api/pyproject.toml",
      },
    ];
    // The finding attaches to the package the PR added and names the
    // standing package in the other ecosystem.
    assert.deepEqual(
      crossEcosystemOverlaps(deps, added).map((f) => [f.dependency, f.summary]),
      [
        [
          "requests",
          "requests (python) covers the same capability (HTTP client) as axios (javascript-typescript)",
        ],
      ],
    );
    assert.deepEqual(crossEcosystemOverlaps(deps, []), []);
  });

  it("in a pull request keys added packages by manifest, leaving untouched projects quiet", () => {
    // Both JS projects declare got. Only apps/new changed in this PR.
    const old = project(JS, "apps/old");
    const next = project(JS, "apps/new");
    const findings = crossEcosystemOverlaps(
      [
        dep(old, "got", "apps/old/package.json"),
        dep(next, "got", "apps/new/package.json"),
        dep(svc, "requests", "services/api/pyproject.toml"),
      ],
      [{ change: "added", name: "got", ecosystem: JS, manifest: "apps/new/package.json" }],
    );
    assert.deepEqual(
      findings.map((f) => [f.dependency, f.affectedFiles]),
      [["got", ["apps/new/package.json"]]],
      "the unchanged apps/old declaration must not be re-reported",
    );
  });

  it("never changes a verdict and adds only info findings", async () => {
    const outcome = (ecosystem: string, deps: Dependency[]): AdapterOutcome => ({
      ecosystem,
      dependencies: deps,
      usages: [],
      graphs: [],
      usageAnalysed: true,
      findings: [],
      detected: { confidence: "high", projects: [deps[0]!.project], evidence: [] },
    });
    const result = await assembleAnalysisResult(
      [outcome(JS, [dep(web, "axios")]), outcome(PY, [dep(svc, "requests")])],
      () => [],
    );
    assert.deepEqual(
      result.findings.map((f) => [f.rule, f.dependency, f.severity]),
      [
        [CROSS_ECOSYSTEM_OVERLAP_RULE, "axios", "info"],
        [CROSS_ECOSYSTEM_OVERLAP_RULE, "requests", "info"],
      ],
    );
  });

  it("only core can mark awareness or adapterNote; adapters and policies can't (#234, #239)", async () => {
    const outcome: AdapterOutcome = {
      ecosystem: JS,
      dependencies: [dep(web, "axios")],
      usages: [],
      graphs: [],
      usageAnalysed: true,
      // An adapter trying to hide a finding behind awareness, even with the
      // overlap rule's id.
      findings: [
        {
          kind: "info",
          rule: CROSS_ECOSYSTEM_OVERLAP_RULE,
          dependency: "axios",
          summary: "adapter note",
          recommendation: "r",
          evidence: [],
          confidence: "high",
          limitations: [],
          affectedFiles: [],
          awareness: true,
          adapterNote: true,
        },
      ],
      detected: { confidence: "high", projects: [web], evidence: [] },
    };
    const result = await assembleAnalysisResult([outcome], () => [
      {
        kind: "info",
        rule: "unverified-no-imports",
        dependency: "axios",
        summary: "policy note",
        recommendation: "r",
        evidence: [],
        confidence: "medium",
        limitations: [],
        affectedFiles: [],
        awareness: true,
        adapterNote: true,
      },
    ]);
    assert.ok(result.findings.length >= 2);
    for (const f of result.findings) {
      assert.equal(f.awareness, undefined, `${f.summary} must not keep awareness`);
      assert.equal(f.adapterNote, undefined, `${f.summary} must not keep adapterNote`);
    }
  });
});
