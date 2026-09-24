import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyseDirectory, createDefaultPolicy, type ProjectRef } from "@ghostdeps/core";
import { createPythonAdapter } from "./adapter.js";
import { parsePyprojectText } from "./pyproject.js";
import { parseRequirementsFiles } from "./requirements.js";
import { memoryHandle } from "./testing/fs-handle.js";

const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
const lines = (
  requirements: { dependency: { name: string; kind: string; declaredLine?: number } }[],
) =>
  Object.fromEntries(
    requirements.map((r) => [
      `${r.dependency.name}/${r.dependency.kind}`,
      r.dependency.declaredLine,
    ]),
  );

describe("declaredLine (#280)", () => {
  it("requirements files: logical line start, per including file, first declaration wins", async () => {
    const result = await parseRequirementsFiles(
      memoryHandle({
        "requirements.txt": [
          "# top",
          "-r base.txt",
          "flask==3.0 \\",
          "    --hash=sha256:abc",
          "PyYAML>=6",
          "typing_extensions",
          "requests[socks] ; python_version > '3.8'",
        ].join("\n"),
        "base.txt": ["", "gunicorn>=22", "flask>=2"].join("\n"),
      }),
      project,
      ["requirements.txt"],
    );
    assert.deepEqual(lines(result.requirements), {
      "gunicorn/runtime": 2,
      "flask/runtime": 3,
      // Written names that do not show the normalised name get no line:
      // core would drop them anyway.
      "pyyaml/runtime": undefined,
      "typing-extensions/runtime": undefined,
      "requests/runtime": 7,
    });
    const flask = result.requirements.find((r) => r.dependency.name === "flask")!;
    assert.equal(flask.dependency.declaredIn, "base.txt");
  });

  it("pyproject: PEP 621, extras, groups, build-system, uv and Poetry tables", () => {
    const text = [
      "[build-system]", // 1
      'requires = ["hatchling>=1.20"]', // 2
      "", // 3
      "[project]", // 4
      'name = "x"', // 5
      "dependencies = [", // 6
      '  "httpx>=0.27",', // 7
      '  "Rich",', // 8
      "]", // 9
      "", // 10
      "[project.optional-dependencies]", // 11
      'fast = ["orjson>=3"]', // 12
      'all = ["orjson>=3", "httpx"]', // 13
      "", // 14
      "[dependency-groups]", // 15
      'test = ["pytest>=8", {include-group = "lint"}]', // 16
      'lint = ["ruff"]', // 17
      "", // 18
      "[tool.uv]", // 19
      'dev-dependencies = ["mypy"]', // 20
      "", // 21
      "[tool.poetry.dependencies]", // 22
      'python = "^3.11"', // 23
      'click = "^8"', // 24
      'attrs = { version = "^23", optional = true }', // 25
      "", // 26
      "[tool.poetry.group.docs.dependencies]", // 27
      'mkdocs = "^1.6"', // 28
      "", // 29
      "[tool.poetry.dependencies.pydantic]", // 30
      'version = "^2"', // 31
    ].join("\n");
    const result = parsePyprojectText(text, project, "pyproject.toml");
    assert.deepEqual(lines(result.requirements), {
      "httpx/runtime": 7,
      "rich/runtime": undefined, // written "Rich"
      "orjson/optional": 12,
      "httpx/optional": 13,
      "pytest/dev": 16,
      "ruff/dev": 17,
      "hatchling/build": 2,
      "mypy/dev": 20,
      "click/runtime": 24,
      "attrs/optional": 25,
      // "[tool.poetry.dependencies.pydantic]": core's token test rejects a
      // name after ".", so a sub-table header gets no line.
      "pydantic/runtime": undefined,
      "mkdocs/dev": 28,
    });
  });

  it("strings in comments, keys of inline tables and multi-line strings are never matched", () => {
    const text = [
      "[project]", // 1
      'description = """', // 2
      'httpx is great"""', // 3
      '# dependencies = ["httpx"]', // 4
      "dependencies = [", // 5
      '  # "httpx" was here', // 6
      '  "httpx",', // 7
      "]", // 8
    ].join("\n");
    const result = parsePyprojectText(text, project, "pyproject.toml");
    assert.deepEqual(lines(result.requirements), { "httpx/runtime": 7 });
  });

  it("end to end: core keeps the lines, so no declaration-line-unavailable note", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gd-py-line-"));
    try {
      await writeFile(
        path.join(dir, "pyproject.toml"),
        [
          "[build-system]",
          'requires = ["hatchling"]',
          "[project]",
          'name = "x"',
          'dependencies = ["httpx>=0.27"]',
          "[tool.poetry.group.docs.dependencies]",
          'mkdocs = "^1.6"',
        ].join("\n"),
      );
      await writeFile(path.join(dir, "requirements.txt"), "\ngunicorn>=22\n");
      await writeFile(path.join(dir, "app.py"), "import os\n");
      const result = await analyseDirectory(dir, {
        adapters: [createPythonAdapter()],
        network: { mode: "offline" },
        recommend: createDefaultPolicy({}),
      });
      assert.ok(!result.findings.some((f) => f.rule === "declaration-line-unavailable"));
      const anchored = Object.fromEntries(
        result.findings
          .filter((f) => f.dependency !== undefined)
          .map((f) => [
            f.dependency,
            f.evidence.filter((e) => e.line !== undefined).map((e) => `${e.file}:${e.line}`),
          ]),
      );
      assert.deepEqual(anchored.httpx, ["pyproject.toml:5"]);
      assert.deepEqual(anchored.gunicorn, ["requirements.txt:2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
