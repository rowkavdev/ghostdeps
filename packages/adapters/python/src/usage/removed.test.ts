import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyseRepository,
  defaultPolicy,
  type AdapterContext,
  type Dependency,
  type ProjectRef,
  type SourceLineChanges,
} from "@ghostdeps/core";
import { createPythonAdapter } from "../adapter.js";
import { findPythonUsage } from "./scan.js";
import { findRemovedPythonUsages } from "./removed.js";
import { memoryHandle } from "../testing/fs-handle.js";

const root: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
const dep = (name: string, project = root): Dependency => ({
  name,
  constraint: "*",
  kind: "runtime",
  project,
  declaredIn: `${project.path === "." ? "" : `${project.path}/`}requirements.txt`,
});
const REQS = "requests\npyyaml\nattrs\n";

function context(files: Record<string, string>, changes?: SourceLineChanges[]): AdapterContext {
  const ctx: AdapterContext = { repository: memoryHandle(files), network: { mode: "offline" } };
  if (changes) ctx.pullRequestSourceChanges = changes;
  return ctx;
}
const lines = (...texts: string[]) => texts.map((text, i) => ({ line: i + 1, text }));
const removedOf = async (ctx: AdapterContext, d: Dependency) =>
  (await findPythonUsage(ctx, d))
    .filter((u) => u.removedInPr === true)
    .map((u) => [u.file, u.line, u.form, u.symbols]);

describe("python removedInPr usages (#287)", () => {
  it("reports imports in a deleted file at their base lines, with symbols", async () => {
    const ctx = context({ "requirements.txt": REQS, "app/main.py": "" }, [
      {
        path: "app/old.py",
        removedLines: lines("import requests", "from yaml import safe_load", "requests.get('x')"),
        addedLines: [],
      },
    ]);
    assert.deepEqual(await removedOf(ctx, dep("requests")), [["app/old.py", 1, "static", ["get"]]]);
    assert.deepEqual(await removedOf(ctx, dep("pyyaml")), [
      ["app/old.py", 2, "static", ["safe_load"]],
    ]);
  });

  it("rebuilds the base of an edited file and cites base-side lines", async () => {
    // base: 1 import os / 2 import requests / 3 import attrs / 4 x = 1
    const head = "import os\nimport attrs\ny = 2\n";
    const ctx = context({ "requirements.txt": REQS, "main.py": head }, [
      {
        path: "main.py",
        removedLines: [
          { line: 2, text: "import requests" },
          { line: 4, text: "x = 1" },
        ],
        addedLines: [{ line: 3, text: "y = 2" }],
      },
    ]);
    assert.deepEqual(await removedOf(ctx, dep("requests")), [["main.py", 2, "static", []]]);
    assert.deepEqual(await removedOf(ctx, dep("attrs")), [], "attrs's line was not removed");
    // Head usage is unaffected and never marked removed.
    const attrs = await findPythonUsage(ctx, dep("attrs"));
    assert.deepEqual(
      attrs.map((u) => [u.file, u.line, u.removedInPr ?? false]),
      [["main.py", 2, false]],
    );
  });

  it("counts a multi-line import when any of its lines was removed", async () => {
    const head = "from yaml import (\n    safe_load,\n)\n";
    const ctx = context({ "requirements.txt": REQS, "m.py": head }, [
      {
        path: "m.py",
        removedLines: [{ line: 3, text: "    dump," }],
        addedLines: [],
      },
    ]);
    assert.deepEqual(await removedOf(ctx, dep("pyyaml")), [
      ["m.py", 1, "static", ["dump", "safe_load"]],
    ]);
  });

  it("ignores removed comments, strings and non-Python files", async () => {
    const ctx = context({ "requirements.txt": REQS, "m.py": "x = 1\n" }, [
      {
        path: "m.py",
        removedLines: [
          { line: 2, text: "# import requests" },
          { line: 3, text: 's = "import requests"' },
        ],
        addedLines: [],
      },
      { path: "notes.md", removedLines: lines("import requests"), addedLines: [] },
      { path: "node_modules/x/y.py", removedLines: lines("import requests"), addedLines: [] },
    ]);
    assert.deepEqual(await removedOf(ctx, dep("requests")), []);
  });

  it("fails closed when the diff does not fit the head file", async () => {
    const ctx = context({ "requirements.txt": REQS, "m.py": "a = 1\n" }, [
      {
        path: "m.py",
        removedLines: [{ line: 9, text: "import requests" }],
        addedLines: [{ line: 7, text: "b = 2" }],
      },
    ]);
    assert.deepEqual(await removedOf(ctx, dep("requests")), []);
  });

  it("attributes by owning project and head resolver; dynamic and TYPE_CHECKING kept", async () => {
    const svc: ProjectRef = { path: "svc", ecosystem: "python", packageManagers: [] };
    const files = {
      "requirements.txt": REQS,
      "svc/requirements.txt": "requests\n",
      "svc/a.py": "",
      "a.py": "",
    };
    const changes: SourceLineChanges[] = [
      { path: "svc/a.py", removedLines: lines("import requests"), addedLines: [] },
      {
        path: "a.py",
        removedLines: lines(
          "import importlib",
          "from typing import TYPE_CHECKING",
          "if TYPE_CHECKING:",
          "    import attrs",
          "m = importlib.import_module('requests')",
          "import left_pad",
        ),
        addedLines: [],
      },
    ];
    const ctx = context(files, changes);
    assert.deepEqual(await removedOf(ctx, dep("requests", svc)), [["svc/a.py", 1, "static", []]]);
    assert.deepEqual(await removedOf(ctx, dep("requests")), [["a.py", 5, "dynamic", []]]);
    const attrs = (await findPythonUsage(ctx, dep("attrs"))).filter((u) => u.removedInPr);
    assert.deepEqual(
      attrs.map((u) => [u.line, u.typeOnly]),
      [[4, true]],
    );
  });

  it("lists the repository for project roots once per run, not per dependency", async () => {
    const ctx = context({ "requirements.txt": REQS, "a.py": "" }, [
      { path: "a.py", removedLines: lines("import requests", "import yaml"), addedLines: [] },
    ]);
    const listFiles = ctx.repository.listFiles.bind(ctx.repository);
    let listings = 0;
    ctx.repository.listFiles = () => {
      listings += 1;
      return listFiles();
    };
    for (const name of ["requests", "pyyaml", "attrs"]) {
      await findRemovedPythonUsages(ctx, dep(name), () => true);
    }
    assert.equal(listings, 1);
  });

  it("no pull request, no removed usages", async () => {
    const ctx = context({ "requirements.txt": REQS, "m.py": "import requests\n" });
    assert.deepEqual(await removedOf(ctx, dep("requests")), []);
  });

  it("engine: removed usages reach the report, but M2 python never gets an unused verdict", async () => {
    const result = await analyseRepository(
      memoryHandle({ "requirements.txt": "requests\nattrs\n", "m.py": "import attrs\n" }),
      {
        adapters: [createPythonAdapter()],
        recommend: defaultPolicy,
        pullRequestChanges: [],
        pullRequestSourceChanges: [
          {
            path: "m.py",
            removedLines: [
              { line: 1, text: "import requests" },
              { line: 2, text: "import attrs" },
            ],
            addedLines: [{ line: 1, text: "import attrs" }],
          },
        ],
      },
    );
    // No referenceAnalysis in M2 (lead ruling on #261): removed-last-usage
    // needs it, so the removal is evidence only, never an unused verdict.
    assert.deepEqual(
      result.findings.filter((f) => f.kind === "unused").map((f) => f.rule),
      [],
    );
    assert.ok(
      result.usages.some(
        (u) => u.dependency === "requests" && u.removedInPr === true && u.line === 1,
      ),
    );
  });
});
