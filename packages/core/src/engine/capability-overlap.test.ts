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
    }
    assert.deepEqual(findings[0]!.affectedFiles, ["apps/admin/package.json", "apps/web/manifest"]);
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
    assert.deepEqual(
      crossEcosystemOverlaps(deps, added).map((f) => f.dependency),
      ["requests"],
    );
    assert.deepEqual(crossEcosystemOverlaps(deps, []), []);
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
});
