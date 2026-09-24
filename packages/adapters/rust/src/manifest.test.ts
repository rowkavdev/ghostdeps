import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext } from "@ghostdeps/core";
import { matchMemberGlob, readManifest } from "./cargo-toml.js";
import { detectRust } from "./detect.js";
import { discoverCrates } from "./discover.js";
import { parseCargoManifest } from "./manifest.js";
import { memoryHandle } from "./testing/fs-handle.js";

const ctx = (files: Record<string, string>): AdapterContext => ({
  repository: memoryHandle(files),
  network: { mode: "offline" },
});

async function parse(files: Record<string, string>) {
  const { crates } = await discoverCrates(ctx(files));
  return crates.map((c) => parseCargoManifest(c.manifest, c.project, c.workspaceRoot));
}

describe("Cargo.toml parsing (#49)", () => {
  it("records git, path and alternative-registry sources without resolving them", async () => {
    const [result] = await parse({
      "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\ng = { git = "https://example.invalid/g.git", tag = "v1" }\np = { path = "../p" }\nr = { version = "2", registry = "corp" }\n`,
    });
    const byName = new Map(result!.dependencies.map((d) => [d.name, d]));
    assert.deepEqual(byName.get("g")?.specifier, {
      type: "git",
      detail: "https://example.invalid/g.git tag=v1",
    });
    assert.equal(byName.get("g")?.constraint, "*");
    assert.deepEqual(byName.get("p")?.specifier, { type: "file", detail: "../p" });
    assert.deepEqual(byName.get("r")?.specifier, { type: "registry", detail: "registry: corp" });
    assert.equal(byName.get("r")?.constraint, "2");
  });

  it("reads target-specific dev and build tables", async () => {
    const [result] = await parse({
      "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n[target.'cfg(unix)'.dev-dependencies]\nnix = "0.29"\n[target.x86_64-pc-windows-msvc.build-dependencies]\nembed-resource = "2"\n`,
    });
    assert.deepEqual(result!.dependencies.map((d) => `${d.name}:${d.kind}`).sort(), [
      "embed-resource:build",
      "nix:dev",
    ]);
    assert.equal(result!.conditions.length, 2);
  });

  it("keeps an optional build dependency as kind build", async () => {
    const [result] = await parse({
      "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n[features]\nbundled = ["dep:cc"]\n[build-dependencies]\ncc = { version = "1", optional = true }\n`,
    });
    assert.equal(result!.dependencies[0]!.kind, "build");
    assert.equal(result!.conditions[0]!.statement, "cc is optional; enabled by feature: bundled");
  });

  it("says so when no feature can enable an optional dependency", async () => {
    const [result] = await parse({
      "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n[features]\nx = ["dep:foo"]\n[dependencies]\nfoo = { version = "1", optional = true }\nbar = { version = "1", optional = true }\n[features.y]\n`,
    });
    // bar keeps its implicit feature; malformed [features.y] (a table) is ignored.
    assert.ok(
      result!.conditions.some((c) => c.statement === "bar is optional; enabled by feature: bar"),
    );
    assert.ok(
      result!.conditions.some((c) => c.statement === "foo is optional; enabled by feature: x"),
    );
  });

  it("turns wrong-typed and sourceless entries into evidence, not exceptions", async () => {
    const [result] = await parse({
      "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nn = 3\ne = ""\ns = { features = ["x"] }\nw = { workspace = true }\nok = "1"\n`,
    });
    assert.deepEqual(
      result!.dependencies.map((d) => d.name),
      ["ok"],
    );
    assert.equal(result!.errors.length, 4);
    assert.ok(result!.errors.every((e) => e.kind === "dependency-malformed"));
  });

  it("merges member features and optional into an inherited workspace dependency", async () => {
    const results = await parse({
      "Cargo.toml": `[workspace]\nmembers = ["m"]\n[workspace.dependencies]\nlog = "0.4"\n`,
      "m/Cargo.toml": `[package]\nname = "m"\nversion = "0.1.0"\n[dependencies]\nlog = { workspace = true, optional = true }\n`,
    });
    const dep = results[0]!.dependencies[0]!;
    assert.equal(dep.constraint, "0.4");
    assert.equal(dep.kind, "optional");
  });

  it("does not attach an excluded crate to the workspace", async () => {
    const { crates } = await discoverCrates(
      ctx({
        "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/old"]\n`,
        "crates/new/Cargo.toml": `[package]\nname = "new"\nversion = "0.1.0"\n`,
        "crates/old/Cargo.toml": `[package]\nname = "old"\nversion = "0.1.0"\n`,
      }),
    );
    const byPath = new Map(crates.map((c) => [c.project.path, c]));
    assert.equal(byPath.get("crates/new")?.workspaceRoot?.root, ".");
    assert.equal(byPath.get("crates/old")?.workspaceRoot, undefined);
  });

  it("follows an explicit package.workspace path", async () => {
    const { crates } = await discoverCrates(
      ctx({
        "ws/Cargo.toml": `[workspace]\nmembers = ["../elsewhere/m"]\n`,
        "elsewhere/m/Cargo.toml": `[package]\nname = "m"\nversion = "0.1.0"\nworkspace = "../../ws"\n`,
        "ws/Cargo.lock": "version = 4\n",
      }),
    );
    assert.equal(crates[0]!.workspaceRoot?.root, "ws");
    assert.equal(crates[0]!.lockfile, "ws/Cargo.lock");
    assert.deepEqual(crates[0]!.project.packageManagers, [
      { name: "cargo", lockfile: "../../ws/Cargo.lock" },
    ]);
  });

  it("matches member globs conservatively", () => {
    assert.ok(matchMemberGlob("crates/*", "crates/a"));
    assert.ok(!matchMemberGlob("crates/*", "crates/a/b"));
    assert.ok(matchMemberGlob("crates/**", "crates/a/b"));
    assert.ok(matchMemberGlob("./tools/x?", "tools/x1"));
    assert.ok(!matchMemberGlob("crates/[ab]", "crates/a"), "character classes fail closed");
    assert.ok(!matchMemberGlob("../out", "out"));
  });

  it("reports the TOML error line for a malformed manifest", async () => {
    const manifest = await readManifest(
      memoryHandle({ "Cargo.toml": `[package]\nname = "x\n` }),
      "Cargo.toml",
    );
    assert.equal(manifest.document, undefined);
    assert.equal(manifest.error?.kind, "manifest-malformed");
  });
});

describe("rust detection", () => {
  it("stays below threshold for a manifest without Rust source", async () => {
    const result = await detectRust(
      ctx({ "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n` }),
    );
    assert.ok(result.confidence < 0.5);
    assert.deepEqual(result.projects, []);
  });

  it("ignores crates under target/ and vendor/", async () => {
    const result = await detectRust(
      ctx({
        "vendor/x/Cargo.toml": `[package]\nname = "x"\nversion = "0.1.0"\n`,
        "vendor/x/src/lib.rs": "",
      }),
    );
    assert.equal(result.confidence, 0);
  });

  it("finds nothing in a repository without Cargo.toml", async () => {
    const result = await detectRust(ctx({ "src/main.rs": "fn main() {}" }));
    assert.deepEqual(result, { confidence: 0, projects: [], evidence: [] });
  });
});
