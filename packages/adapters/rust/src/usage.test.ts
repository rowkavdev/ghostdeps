import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { createRustAdapter } from "./adapter.js";
import { detectRust } from "./detect.js";
import { parseRust } from "./parser.js";
import { collectReferences, findUsage } from "./usage.js";
import { fixtureHandle, memoryHandle } from "./testing/fs-handle.js";

const fixture = (name: string): AdapterContext => ({
  repository: fixtureHandle("rust", name),
  network: { mode: "offline" },
});

async function usagesByDep(context: AdapterContext): Promise<Map<string, string[]>> {
  const adapter = createRustAdapter();
  const { projects } = await detectRust(context);
  const deps = await adapter.listDirectDependencies(context, projects);
  const out = new Map<string, string[]>();
  for (const dep of deps) {
    const usages = await findUsage(context, dep);
    out.set(
      dep.name,
      usages.map((u) => `${u.file}:${u.line}`),
    );
  }
  return out;
}

async function refs(source: string): Promise<string[]> {
  const tree = await parseRust(source);
  return collectReferences(tree!).map(
    (r) => `${r.crate}:${r.line}${r.symbol ? `:${r.symbol}` : ""}`,
  );
}

describe("rust usage scanning (#50)", () => {
  it("finds use, paths, renames and build.rs usage in single-crate", async () => {
    const byDep = await usagesByDep(fixture("single-crate"));
    assert.deepEqual(byDep.get("serde"), ["src/main.rs:1"]);
    assert.deepEqual(byDep.get("anyhow"), ["src/main.rs:8"]);
    assert.deepEqual(byDep.get("serde_json"), ["src/main.rs:9"], "renamed json -> serde_json");
    assert.deepEqual(byDep.get("cc"), ["build.rs:2"]);
    assert.deepEqual(byDep.get("regex"), []);
    assert.deepEqual(byDep.get("tempfile"), []);
  });

  it("scopes usage to each workspace member and maps - to _", async () => {
    const byDep = await usagesByDep(fixture("workspace"));
    assert.deepEqual(byDep.get("ws-core"), ["crates/cli/src/main.rs:11"]);
    assert.deepEqual(byDep.get("clap"), ["crates/cli/src/main.rs:1"]);
    assert.deepEqual(byDep.get("tokio"), ["crates/core/src/lib.rs:9"]);
    assert.deepEqual(byDep.get("serde"), ["crates/core/src/lib.rs:1"]);
  });

  it("sees feature- and target-gated code", async () => {
    const byDep = await usagesByDep(fixture("feature-conditional"));
    assert.deepEqual(byDep.get("serde_json"), ["src/lib.rs:3"]);
    assert.deepEqual(byDep.get("winapi"), ["src/lib.rs:8"]);
    assert.deepEqual(byDep.get("flate2"), []);
  });

  it("extracts every use-tree and path shape", async () => {
    const found = await refs(
      [
        "use serde::{Deserialize, Serialize};",
        "use ::regex as re;",
        "use {anyhow::Result, json};",
        "extern crate log;",
        "use crate::local::x; use self::y; use super::z; use std::io;",
        'fn f() { tokio::spawn(async {}); anyhow::bail!("x"); let _v: ws_core::Job; }',
        "#[derive(clap::Parser)] struct A;",
        'fn g() { println!("{}", serde_json::to_string(&1).unwrap()); }',
        "fn h() { let _ = a::b::c::d(); }",
      ].join("\n"),
    );
    for (const want of [
      "serde:1",
      "regex:2",
      "anyhow:3",
      "json:3",
      "log:4",
      "tokio:6:spawn",
      "anyhow:6:bail",
      "ws_core:6:Job",
      "clap:7:Parser",
      "serde_json:8:to_string",
      "a:9:b",
    ]) {
      assert.ok(found.includes(want), `missing ${want} in ${JSON.stringify(found)}`);
    }
    for (const unwanted of ["crate", "self", "super", "std", "b", "c"]) {
      assert.ok(!found.some((f) => f.startsWith(`${unwanted}:`)), `unexpected ${unwanted}`);
    }
  });

  it("tolerates broken source without throwing", async () => {
    const found = await refs('use serde::Serialize;\nfn broken( {\n  regex::Regex::new("x")\n');
    assert.ok(found.includes("serde:1"));
  });

  it("does not attribute a nested crate's source to its parent", async () => {
    const root: ProjectRef = { path: ".", ecosystem: "rust", packageManagers: [] };
    const context: AdapterContext = {
      repository: memoryHandle({
        "Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nlog = "0.4"\n`,
        "src/lib.rs": "",
        "tools/gen/Cargo.toml": `[package]\nname = "gen"\nversion = "0.1.0"\n`,
        "tools/gen/src/main.rs": 'fn main() { log::info!("x"); }\n',
      }),
      network: { mode: "offline" },
    };
    const dep: Dependency = {
      name: "log",
      constraint: "0.4",
      kind: "runtime",
      project: root,
      declaredIn: "Cargo.toml",
    };
    assert.deepEqual(await findUsage(context, dep), []);
  });
});
