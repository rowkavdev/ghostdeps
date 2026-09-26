import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPABILITY_CATALOGUE } from "../capabilities/index.js";
import type { DependencyChange } from "../diff/dependency-changes.js";
import type { Dependency, ProjectRef } from "../types/index.js";
import {
  sameEcosystemDuplicates,
  SAME_ECOSYSTEM_DUPLICATES_RULE,
} from "./capability-duplicates.js";

const JS = "javascript-typescript";
const PY = "python";
const project = (ecosystem: string, path: string): ProjectRef => ({
  ecosystem,
  path,
  packageManagers: [],
});
const web = project(JS, "apps/web");
const dep = (
  p: ProjectRef,
  name: string,
  declaredIn = `${p.path}/package.json`,
  kind: Dependency["kind"] = "runtime",
): Dependency => ({
  name,
  constraint: "*",
  kind,
  project: p,
  declaredIn,
});

describe("sameEcosystemDuplicates (#58, declaration tier)", () => {
  it("reports each declared member of a same-project cluster, naming the others", () => {
    const findings = sameEcosystemDuplicates([dep(web, "axios"), dep(web, "got")]);
    assert.deepEqual(
      findings.map((f) => [f.dependency, f.summary]),
      [
        ["axios", "axios and got all provide HTTP client in apps/web"],
        ["got", "got and axios all provide HTTP client in apps/web"],
      ],
    );
    for (const f of findings) {
      assert.equal(f.kind, "duplicate-capability");
      assert.equal(f.rule, SAME_ECOSYSTEM_DUPLICATES_RULE);
      assert.equal(f.confidence, "low", "declaration evidence only");
      assert.ok(f.dependency, "never a run note (#197)");
      assert.equal(f.awareness, true, "awareness-only per the #58 arbiter ruling (#234)");
      assert.ok(f.limitations.length > 0, "declaration tier always states its limits");
      assert.match(f.recommendation, /Review whether/);
      assert.match(f.recommendation, /no change is suggested/i, "informs, never recommends action");
      assert.doesNotMatch(f.recommendation, /remove \w+ from/i, "never an auto-remove claim");
    }
    assert.deepEqual(findings[0]!.affectedFiles, ["apps/web/package.json"]);
  });

  it("lists every member when three packages share a capability", () => {
    const findings = sameEcosystemDuplicates([
      dep(web, "node-fetch"),
      dep(web, "axios"),
      dep(web, "got"),
    ]);
    assert.deepEqual(
      findings.map((f) => f.dependency),
      ["axios", "got", "node-fetch"],
    );
    const axios = findings.find((f) => f.dependency === "axios")!;
    assert.equal(axios.summary, "axios and got, node-fetch all provide HTTP client in apps/web");
  });

  it("stays quiet for a single declared member and for unrelated packages", () => {
    assert.deepEqual(sameEcosystemDuplicates([dep(web, "axios")]), []);
    assert.deepEqual(sameEcosystemDuplicates([dep(web, "react"), dep(web, "axios")]), []);
  });

  it("stays quiet across projects of one ecosystem (monorepo structure is not duplication)", () => {
    const admin = project(JS, "apps/admin");
    assert.deepEqual(
      sameEcosystemDuplicates([dep(web, "axios"), dep(admin, "got", "apps/admin/package.json")]),
      [],
    );
  });

  it("stays quiet across ecosystems (that is #55's job)", () => {
    const svc = project(PY, "services/api");
    assert.deepEqual(
      sameEcosystemDuplicates([
        dep(web, "axios"),
        dep(svc, "requests", "services/api/pyproject.toml"),
      ]),
      [],
    );
  });

  it("matches Python names per PEP 503", () => {
    const svc = project(PY, "services/api");
    const findings = sameEcosystemDuplicates([
      dep(svc, "Requests", "services/api/pyproject.toml"),
      dep(svc, "HTTPX", "services/api/pyproject.toml"),
    ]);
    assert.deepEqual(
      findings.map((f) => f.dependency),
      ["HTTPX", "Requests"],
    );
  });

  it("skips peer and optional declarations and non-registry specifiers", () => {
    assert.deepEqual(
      sameEcosystemDuplicates([
        dep(web, "axios"),
        dep(web, "got", "apps/web/package.json", "peer"),
      ]),
      [],
    );
    assert.deepEqual(
      sameEcosystemDuplicates([
        dep(web, "axios"),
        dep(web, "got", "apps/web/package.json", "optional"),
      ]),
      [],
    );
    const linked: Dependency = {
      ...dep(web, "got"),
      specifier: { type: "link", detail: "../got" },
    };
    assert.deepEqual(sameEcosystemDuplicates([dep(web, "axios"), linked]), []);
  });

  it("fires on clusters the cross-ecosystem view skips (test runners, #211)", () => {
    const findings = sameEcosystemDuplicates([dep(web, "jest"), dep(web, "vitest")]);
    assert.equal(findings.length, 2);
    assert.equal(findings[0]!.summary, "jest and vitest all provide test runner in apps/web");
  });

  it("anchors evidence at the declaration, with the line when known", () => {
    const withLine: Dependency = { ...dep(web, "axios"), declaredLine: 12 };
    const findings = sameEcosystemDuplicates([withLine, dep(web, "got")]);
    const axios = findings.find((f) => f.dependency === "axios")!;
    const declared = axios.evidence.filter((e) => e.kind === "declared-in");
    assert.deepEqual(
      declared.map((e) => [e.file, e.line]),
      [["apps/web/package.json", 12]],
    );
    assert.equal(axios.evidence[0]!.kind, "capability-cluster");
  });

  it("uses the project root wording for the root project", () => {
    const root = project(JS, ".");
    const findings = sameEcosystemDuplicates([
      dep(root, "axios", "package.json"),
      dep(root, "got", "package.json"),
    ]);
    assert.equal(findings[0]!.summary, "axios and got all provide HTTP client in the project root");
  });

  it("accepts an injected catalogue and stays deterministic", () => {
    const deps = [dep(web, "axios"), dep(web, "got"), dep(web, "zod"), dep(web, "yup")];
    const first = sameEcosystemDuplicates(deps, undefined, CAPABILITY_CATALOGUE);
    const second = sameEcosystemDuplicates([...deps].reverse(), undefined, CAPABILITY_CATALOGUE);
    assert.deepEqual(first, second, "input order never changes the output");
    assert.deepEqual(sameEcosystemDuplicates(deps, undefined, { version: 1, clusters: [] }), []);
  });

  it("in a pull request reports only the packages the PR added (#55 semantics)", () => {
    const changes: DependencyChange[] = [
      { change: "added", name: "got", ecosystem: JS, manifest: "apps/web/package.json" },
    ];
    const findings = sameEcosystemDuplicates([dep(web, "axios"), dep(web, "got")], changes);
    assert.deepEqual(
      findings.map((f) => f.dependency),
      ["got"],
      "the pre-existing member is not re-reported on every PR",
    );
  });

  it("in a pull request stays quiet when the PR only changed or removed members", () => {
    const changes: DependencyChange[] = [
      { change: "changed", name: "got", ecosystem: JS, manifest: "apps/web/package.json" },
      { change: "removed", name: "axios", ecosystem: JS, manifest: "apps/web/package.json" },
    ];
    assert.deepEqual(sameEcosystemDuplicates([dep(web, "axios"), dep(web, "got")], changes), []);
  });

  it("in a pull request matches the added package to its own ecosystem", () => {
    const changes: DependencyChange[] = [
      { change: "added", name: "axios", ecosystem: PY, manifest: "services/api/pyproject.toml" },
    ];
    assert.deepEqual(
      sameEcosystemDuplicates([dep(web, "axios"), dep(web, "got")], changes),
      [],
      "an axios added to a Python project is not the JS axios",
    );
  });
});
