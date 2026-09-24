import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef, SourceLineChanges } from "@ghostdeps/core";
import { findRemovedUsages, reconstructBase } from "./removed.js";
import { findUsage } from "./usage.js";
import { memoryHandle } from "./testing/fs-handle.js";

const root: ProjectRef = { path: ".", ecosystem: "rust", packageManagers: [] };
const dep = (name: string, declaredIn = "Cargo.toml", project = root): Dependency => ({
  name,
  constraint: "1",
  kind: "runtime",
  project,
  declaredIn,
});
const MANIFEST = `[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nregex = "1"\nserde = "1"\nfast-json = { package = "simd-json", version = "0.13" }\n`;

function context(files: Record<string, string>, changes?: SourceLineChanges[]): AdapterContext {
  const ctx: AdapterContext = { repository: memoryHandle(files), network: { mode: "offline" } };
  if (changes) ctx.pullRequestSourceChanges = changes;
  return ctx;
}
const lines = (...texts: string[]) => texts.map((text, i) => ({ line: i + 1, text }));

describe("rust removedInPr usages (#249)", () => {
  it("reports uses in a deleted file at their base lines", async () => {
    const ctx = context({ "Cargo.toml": MANIFEST, "src/lib.rs": "" }, [
      {
        path: "src/old.rs",
        removedLines: lines("use regex::Regex;", 'fn f() { let _ = regex::escape("x"); }'),
        addedLines: [],
      },
    ]);
    const usages = await findRemovedUsages(ctx, dep("regex"));
    assert.deepEqual(
      usages.map((u) => [u.file, u.line, u.removedInPr, u.symbols]),
      [
        ["src/old.rs", 1, true, []],
        ["src/old.rs", 2, true, ["escape"]],
      ],
    );
  });

  it("ignores removed comments and strings, and unchanged lines", async () => {
    const head = "use serde::Serialize;\nfn main() {}\n";
    const ctx = context({ "Cargo.toml": MANIFEST, "src/main.rs": head }, [
      {
        path: "src/main.rs",
        removedLines: [
          { line: 2, text: "// regex::Regex was here" },
          { line: 3, text: 'const S: &str = "regex::escape";' },
        ],
        addedLines: [],
      },
    ]);
    assert.deepEqual(await findRemovedUsages(ctx, dep("regex")), []);
    assert.deepEqual(
      await findRemovedUsages(ctx, dep("serde")),
      [],
      "serde's line was not removed",
    );
  });

  it("counts a multi-line use tree from any removed line, cited at its first line", async () => {
    const head = "fn main() {}\n";
    const ctx = context({ "Cargo.toml": MANIFEST, "src/main.rs": head }, [
      {
        path: "src/main.rs",
        removedLines: [
          { line: 1, text: "use serde::{" },
          { line: 2, text: "    Deserialize," },
          { line: 3, text: "};" },
        ],
        addedLines: [],
      },
    ]);
    const usages = await findRemovedUsages(ctx, dep("serde"));
    assert.deepEqual(
      usages.map((u) => u.line),
      [1],
    );
  });

  it("matches renamed crates by their manifest key", async () => {
    const ctx = context({ "Cargo.toml": MANIFEST, "src/lib.rs": "" }, [
      { path: "src/lib.rs", removedLines: lines("use fast_json::to_string;"), addedLines: [] },
    ]);
    const usages = await findRemovedUsages(ctx, dep("simd-json"));
    assert.equal(usages.length, 1);
  });

  it("scopes removed usage to the owning crate", async () => {
    const member: ProjectRef = { path: "tools/gen", ecosystem: "rust", packageManagers: [] };
    const ctx = context(
      {
        "Cargo.toml": MANIFEST,
        "src/lib.rs": "",
        "tools/gen/Cargo.toml": `[package]\nname = "gen"\nversion = "0.1.0"\n[dependencies]\nregex = "1"\n`,
      },
      [{ path: "tools/gen/src/main.rs", removedLines: lines("use regex::Regex;"), addedLines: [] }],
    );
    assert.deepEqual(await findRemovedUsages(ctx, dep("regex")), []);
    const usages = await findRemovedUsages(ctx, dep("regex", "tools/gen/Cargo.toml", member));
    assert.equal(usages.length, 1);
  });

  it("skips a file whose base cannot be rebuilt from the diff", async () => {
    const ctx = context({ "Cargo.toml": MANIFEST, "src/main.rs": "fn main() {}\n" }, [
      {
        path: "src/main.rs",
        removedLines: [{ line: 9, text: "use regex::Regex;" }],
        addedLines: [],
      },
    ]);
    assert.deepEqual(await findRemovedUsages(ctx, dep("regex")), []);
  });

  it("adds nothing on a full scan and merges with head usage in PR mode", async () => {
    const files = { "Cargo.toml": MANIFEST, "src/main.rs": "use serde::Serialize;\n" };
    assert.deepEqual(await findRemovedUsages(context(files), dep("serde")), []);
    const pr = context(files, [
      {
        path: "src/main.rs",
        removedLines: [{ line: 2, text: "fn f() { serde_json(); serde::de::x(); }" }],
        addedLines: [],
      },
    ]);
    const all = await findUsage(pr, dep("serde"));
    assert.deepEqual(
      all.map((u) => [u.line, u.removedInPr === true]),
      [
        [1, false],
        [2, true],
      ],
    );
  });

  it("rebuilds base from head, removed and added lines", () => {
    const base = reconstructBase(["a", "NEW", "c"], {
      path: "x.rs",
      removedLines: [{ line: 2, text: "b" }],
      addedLines: [{ line: 2, text: "NEW" }],
    });
    assert.deepEqual(base, ["a", "b", "c"]);
  });
});
