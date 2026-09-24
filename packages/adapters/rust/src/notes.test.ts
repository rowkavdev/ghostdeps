import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { createRustAdapter, parseErrorNotes } from "./adapter.js";
import { memoryHandle } from "./testing/fs-handle.js";
import { findUsage, parseErrorLimitations } from "./usage.js";

const ctx = (files: Record<string, string>): AdapterContext => ({
  repository: memoryHandle(files),
  network: { mode: "offline" },
});
const project = (path: string): ProjectRef => ({ path, ecosystem: "rust", packageManagers: [] });
const MANIFEST = `[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nregex = "1"\n`;
const BROKEN = 'fn main( {\n  let _ = regex::Regex::new("a");\n}\n';

describe("rust parse-error notes (#291)", () => {
  it("adds no note when every file parses", async () => {
    const context = ctx({
      "Cargo.toml": MANIFEST,
      "src/main.rs": "use regex::Regex;\nfn main() {}\n",
    });
    assert.deepEqual(await parseErrorNotes(context, [project(".")]), []);
  });

  it("names a broken file once, as a run-level note, and keeps its usages", async () => {
    const context = ctx({
      "Cargo.toml": MANIFEST,
      "src/main.rs": BROKEN,
      "src/ok.rs": "pub fn f() {}\n",
    });
    const dep: Dependency = {
      name: "regex",
      constraint: "1",
      kind: "runtime",
      project: project("."),
      declaredIn: "Cargo.toml",
    };
    const usages = await findUsage(context, dep);
    assert.deepEqual(
      usages.map((u) => `${u.file}:${u.line}`),
      ["src/main.rs:2"],
    );
    const notes = await createRustAdapter().notes!(context, [project("."), project(".")]);
    assert.deepEqual(notes, [
      {
        statement:
          "1 Rust file has syntax errors, so crate references in them may be missed: src/main.rs",
      },
    ]);
    assert.equal(notes[0]!.dependency, undefined, "run-level, not tied to a dependency");
    assert.doesNotMatch(notes[0]!.statement, /unused|verdict/);
  });

  it("keeps per-crate limitations in the js parse-error shape", async () => {
    const context = ctx({
      "Cargo.toml": MANIFEST,
      "src/main.rs": BROKEN,
      "tools/gen/Cargo.toml": MANIFEST.replace('"a"', '"gen"'),
      "tools/gen/src/main.rs": "fn main() {}\n",
    });
    assert.deepEqual(await parseErrorLimitations(context, "."), [
      {
        kind: "parse-error",
        statement: "src/main.rs has syntax errors; usages found may be incomplete",
        file: "src/main.rs",
      },
    ]);
    assert.deepEqual(await parseErrorLimitations(context, "tools/gen"), []);
  });

  it("counts files beyond the first five", async () => {
    const files: Record<string, string> = { "Cargo.toml": MANIFEST };
    for (let i = 1; i <= 7; i++) files[`src/m${i}.rs`] = BROKEN;
    const [note] = await parseErrorNotes(ctx(files), [project(".")]);
    assert.equal(
      note?.statement,
      "7 Rust files have syntax errors, so crate references in them may be missed: src/m1.rs, src/m2.rs, src/m3.rs, src/m4.rs, src/m5.rs and 2 more",
    );
  });
});
