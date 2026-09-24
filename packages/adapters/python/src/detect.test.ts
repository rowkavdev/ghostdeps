import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext } from "@ghostdeps/core";
import { DETECTION_CONFIDENCE_THRESHOLD, detectPython, isRequirementsFile } from "./detect.js";
import { memoryHandle } from "./testing/fs-handle.js";

const ctx = (files: Record<string, string>): AdapterContext => ({
  repository: memoryHandle(files),
  network: { mode: "offline" },
});

describe("detectPython (issue #42)", () => {
  it("returns zero confidence and no evidence without Python manifests", async () => {
    const result = await detectPython(ctx({ "main.py": "print(1)\n", "README.md": "" }));
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.projects, []);
    assert.deepEqual(result.evidence, []);
  });

  it("keeps a pyproject.toml without source below threshold", async () => {
    const result = await detectPython(ctx({ "pyproject.toml": "[tool.ruff]\n" }));
    assert.ok(result.confidence < DETECTION_CONFIDENCE_THRESHOLD);
    assert.deepEqual(result.projects, []);
    assert.ok(result.evidence.some((e) => e.kind === "project-skipped"));
  });

  it("scores lockfile, pyproject and source volume", async () => {
    const files: Record<string, string> = {
      "pyproject.toml": '[project]\nname = "x"\n',
      "uv.lock": "version = 1\n",
    };
    for (let i = 0; i < 5; i++) files[`src/x/m${i}.py`] = "";
    const result = await detectPython(ctx(files));
    assert.equal(result.confidence, 1);
    assert.deepEqual(result.projects, [
      { path: ".", ecosystem: "python", packageManagers: [{ name: "uv", lockfile: "uv.lock" }] },
    ]);
  });

  it("names poetry from a [tool.poetry] table without a lockfile", async () => {
    const result = await detectPython(
      ctx({ "pyproject.toml": '[tool.poetry]\nname = "x"\n', "x/__init__.py": "" }),
    );
    assert.deepEqual(result.projects[0]?.packageManagers, [{ name: "poetry" }]);
  });

  it("assigns source to the deepest project root", async () => {
    const result = await detectPython(
      ctx({
        "requirements.txt": "",
        "services/a/pyproject.toml": "[project]\n",
        "services/a/a.py": "",
        "tools/run.py": "",
      }),
    );
    assert.deepEqual(result.projects.map((p) => p.path).sort(), [".", "services/a"]);
  });

  it("ignores virtualenvs and caches", async () => {
    const result = await detectPython(
      ctx({ "requirements.txt": "", ".venv/lib/x.py": "", "venv/pyproject.toml": "" }),
    );
    assert.deepEqual(result.projects, []);
  });

  it("does not count .pyi stubs as source", async () => {
    const result = await detectPython(ctx({ "setup.cfg": "", "pkg/__init__.pyi": "" }));
    assert.deepEqual(result.projects, []);
  });

  it("records setup.py as unanalysable, never executed", async () => {
    const result = await detectPython(ctx({ "setup.py": "import os\n", "pkg/a.py": "" }));
    assert.ok(result.evidence.some((e) => e.kind === "setup-py-unanalysable"));
    assert.equal(result.projects.length, 1);
  });

  it("tolerates an unreadable pyproject.toml", async () => {
    const repository = memoryHandle({ "pyproject.toml": "", "a.py": "" });
    const result = await detectPython({
      repository: { ...repository, readFile: () => Promise.reject(new Error("boom")) },
      network: { mode: "offline" },
    });
    assert.equal(result.projects.length, 1);
  });
});

describe("isRequirementsFile", () => {
  it("matches common requirements file names", () => {
    for (const name of [
      "requirements.txt",
      "requirements-dev.txt",
      "requirements_test.txt",
      "dev-requirements.txt",
      "requirements.in",
    ]) {
      assert.ok(isRequirementsFile(name), name);
    }
  });

  it("rejects look-alikes", () => {
    for (const name of ["requirements.md", "myrequirements.txt", "notes.txt"]) {
      assert.ok(!isRequirementsFile(name), name);
    }
  });
});
