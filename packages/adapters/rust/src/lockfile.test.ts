import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, ProjectRef } from "@ghostdeps/core";
import { detectRust } from "./detect.js";
import { buildDependencyGraph, crateGraph, parseCargoLock } from "./lockfile.js";
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
});
