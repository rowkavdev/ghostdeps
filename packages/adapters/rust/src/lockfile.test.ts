import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, ProjectRef } from "@ghostdeps/core";
import { detectRust } from "./detect.js";
import { analyseCargoLocks, buildDependencyGraph, crateGraph, parseCargoLock } from "./lockfile.js";
import { fixtureHandle, memoryHandle } from "./testing/fs-handle.js";

const fixture = (name: string): AdapterContext => ({
  repository: fixtureHandle("rust", name),
  network: { mode: "offline" },
});
const project: ProjectRef = { path: ".", ecosystem: "rust", packageManagers: [] };

describe("Cargo.lock graph (#50)", () => {
  it("builds the single-crate graph with dev derived from dev-dependencies", async () => {
    const context = fixture("single-crate");
    const { projects } = await detectRust(context);
    const [graph] = await buildDependencyGraph(context, projects);
    assert.equal(graph!.incomplete, false);
    const byName = new Map(graph!.nodes.map((n) => [n.name, n]));
    assert.equal(byName.has("single-crate"), false, "the crate itself is not a node");
    assert.deepEqual(graph!.transitiveClosure.serde_json, ["itoa", "ryu", "serde", "serde_derive"]);
    assert.deepEqual(graph!.transitiveClosure.regex, ["aho-corasick", "memchr"]);
    assert.equal(byName.get("tempfile")?.dev, true);
    assert.equal(byName.get("fastrand")?.dev, true);
    assert.equal(byName.get("cc")?.dev, false, "build deps are not dev");
    assert.equal(byName.get("serde")?.dev, false);
  });

  it("builds per-member graphs from the workspace root lockfile", async () => {
    const context = fixture("workspace");
    const { projects } = await detectRust(context);
    const graphs = await buildDependencyGraph(context, projects);
    const byPath = new Map(graphs.map((g) => [g.project.path, g]));
    assert.deepEqual(Object.keys(byPath.get("crates/cli")!.transitiveClosure).sort(), [
      "clap",
      "ws-core",
    ]);
    assert.deepEqual(byPath.get("crates/cli")!.transitiveClosure["ws-core"], [
      "pin-project-lite",
      "serde",
      "tokio",
    ]);
    assert.deepEqual(byPath.get("crates/core")!.transitiveClosure.tokio, ["pin-project-lite"]);
  });

  it("marks a crate without a lockfile incomplete", async () => {
    const context = fixture("feature-conditional");
    const { projects } = await detectRust(context);
    const [graph] = await buildDependencyGraph(context, projects);
    assert.equal(graph!.incomplete, true);
    assert.deepEqual(graph!.nodes, []);
  });

  it("marks an unparseable lockfile incomplete instead of throwing", async () => {
    const context: AdapterContext = {
      repository: memoryHandle({
        "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n`,
        "Cargo.lock": "[[package]\nname=",
        "src/lib.rs": "",
      }),
      network: { mode: "offline" },
    };
    const [graph] = await buildDependencyGraph(context, [project]);
    assert.equal(graph!.incomplete, true);
  });

  it("disambiguates duplicate versions by the version in the reference", () => {
    const lock = parseCargoLock(`version = 4
[[package]]
name = "app"
version = "0.1.0"
dependencies = ["rand 0.8.5", "rand 0.7.3"]
[[package]]
name = "rand"
version = "0.8.5"
source = "registry+https://github.com/rust-lang/crates.io-index"
[[package]]
name = "rand"
version = "0.7.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
`);
    const { graph } = crateGraph(project, "app", lock, new Set(), "Cargo.lock");
    assert.equal(graph.incomplete, false);
    assert.deepEqual(
      graph.nodes.map((n) => `${n.name}@${n.version}`),
      ["rand@0.7.3", "rand@0.8.5"],
    );
  });

  it("flags an ambiguous reference as incomplete", () => {
    const lock = parseCargoLock(`[[package]]
name = "app"
version = "0.1.0"
dependencies = ["rand"]
[[package]]
name = "rand"
version = "0.8.5"
[[package]]
name = "rand"
version = "0.7.3"
`);
    const { graph, evidence } = crateGraph(project, "app", lock, new Set(), "Cargo.lock");
    assert.equal(graph.incomplete, true);
    assert.equal(evidence[0]?.kind, "lockfile-unresolved-reference");
  });

  it("reports a lockfile without the crate as incomplete", () => {
    const { graph, evidence } = crateGraph(
      project,
      "missing",
      parseCargoLock("version = 4\n"),
      new Set(),
      "Cargo.lock",
    );
    assert.equal(graph.incomplete, true);
    assert.equal(evidence[0]?.kind, "lockfile-missing-root");
  });

  it("marks a stale lockfile incomplete and says what it misses (#225)", async () => {
    const context: AdapterContext = {
      repository: memoryHandle({
        "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nlog = "0.4"\nregex = "1"\n`,
        "Cargo.lock": `version = 4\n[[package]]\nname = "a"\nversion = "0.1.0"\ndependencies = ["log"]\n[[package]]\nname = "log"\nversion = "0.4.22"\n`,
        "src/lib.rs": "",
      }),
      network: { mode: "offline" },
    };
    const { graphs, evidence } = await analyseCargoLocks(context, [project]);
    assert.equal(graphs[0]!.incomplete, true);
    assert.deepEqual(Object.keys(graphs[0]!.transitiveClosure), ["log"]);
    assert.equal(evidence[0]?.kind, "lockfile-stale");
    assert.match(evidence[0]!.statement, /does not lock regex declared by a/);
    const detection = await detectRust(context);
    assert.ok(
      detection.evidence.some((e) => e.kind === "lockfile-stale"),
      "surfaced in detection",
    );
  });

  it("keeps fixture lockfiles complete", async () => {
    for (const name of ["single-crate", "workspace"]) {
      const context = fixture(name);
      const { projects } = await detectRust(context);
      const { graphs, evidence } = await analyseCargoLocks(context, projects);
      assert.ok(
        graphs.every((g) => !g.incomplete),
        `${name}: ${JSON.stringify(evidence)}`,
      );
    }
  });

  it("surfaces a missing lockfile as detection evidence", async () => {
    const detection = await detectRust(fixture("feature-conditional"));
    assert.ok(detection.evidence.some((e) => e.kind === "lockfile-missing"));
  });

  it("sorts nodes by code point, not locale", () => {
    const lock = parseCargoLock(`[[package]]
name = "app"
version = "0.1.0"
dependencies = ["a-lib", "Zed", "_u"]
[[package]]
name = "a-lib"
version = "1.0.0"
[[package]]
name = "Zed"
version = "1.0.0"
[[package]]
name = "_u"
version = "1.0.0"
`);
    const { graph } = crateGraph(project, "app", lock, new Set(), "Cargo.lock");
    assert.deepEqual(
      graph.nodes.map((n) => n.name),
      ["Zed", "_u", "a-lib"],
    );
  });

  it("reads and parses each Cargo.lock once per run (#246)", async () => {
    const files = {
      "Cargo.toml": `[workspace]\nmembers = ["a", "b"]\n`,
      "Cargo.lock": `version = 4\n[[package]]\nname = "a"\nversion = "0.1.0"\n[[package]]\nname = "b"\nversion = "0.1.0"\n`,
      "a/Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n`,
      "a/src/lib.rs": "",
      "b/Cargo.toml": `[package]\nname = "b"\nversion = "0.1.0"\n`,
      "b/src/lib.rs": "",
    };
    const base = memoryHandle(files);
    const reads = new Map<string, number>();
    const context: AdapterContext = {
      repository: {
        ...base,
        readFile: (path: string) => {
          reads.set(path, (reads.get(path) ?? 0) + 1);
          return base.readFile(path);
        },
      },
      network: { mode: "offline" },
    };
    const detection = await detectRust(context);
    const graphs = await buildDependencyGraph(context, detection.projects);
    assert.equal(graphs.length, 2);
    assert.ok(graphs.every((g) => !g.incomplete));
    assert.equal(reads.get("Cargo.lock"), 1);
    // A new run (new context) reads it again.
    await buildDependencyGraph({ ...context }, detection.projects);
    assert.equal(reads.get("Cargo.lock"), 2);
  });
});
