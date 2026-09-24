import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyseDirectory, createDefaultPolicy, type ProjectRef } from "@ghostdeps/core";
import { createPythonAdapter } from "./adapter.js";
import { lineNamesDependency, pep503 } from "./declared-line.js";
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
      // Written names match under PEP 503 (#286), as core checks them.
      "pyyaml/runtime": 5,
      "typing-extensions/runtime": 6,
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
      "rich/runtime": 8, // written "Rich", same name under PEP 503
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

  it("PEP 503 token match (#286): same package only, never a longer name", () => {
    assert.equal(lineNamesDependency('  "PyYAML>=6",', "pyyaml"), true);
    assert.equal(lineNamesDependency("typing_extensions", "typing-extensions"), true);
    assert.equal(
      lineNamesDependency(
        "  \"Ruamel.Yaml[jinja2]==0.18 ; python_version < '3.13'\",",
        "ruamel-yaml",
      ),
      true,
    );
    assert.equal(lineNamesDependency("Typing__Extensions", "typing-extensions"), true);
    assert.equal(lineNamesDependency('  "pyyaml-include",', "pyyaml"), false);
    assert.equal(lineNamesDependency('  "PyYAML-Include",', "pyyaml"), false);
    assert.equal(lineNamesDependency("[tool.poetry.dependencies.pydantic]", "pydantic"), false);
    assert.equal(pep503("a-_.b"), "a-b");
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

  it("stays linear on large manifests (untrusted input)", () => {
    // ~30k dependencies, ~0.5 MB: each lookup is a map hit, never a scan.
    const count = 30_000;
    const deps = Array.from({ length: count }, (_, i) => `  "pkg${i}>=1",`);
    const text = ["[project]", 'name = "x"', "dependencies = [", ...deps, "]"].join("\n");
    const started = performance.now();
    const result = parsePyprojectText(text, project, "pyproject.toml");
    const elapsed = performance.now() - started;
    assert.equal(result.requirements.length, count);
    assert.equal(result.requirements[count - 1]!.dependency.declaredLine, count + 3);
    assert.ok(elapsed < 3000, `took ${Math.round(elapsed)} ms`);

    // All on one line: no rescanning per declaration, and no line offered.
    const oneLine = `[project]\nname = "x"\ndependencies = [${deps.join(" ")}]`;
    const t0 = performance.now();
    const flat = parsePyprojectText(oneLine, project, "pyproject.toml");
    assert.ok(performance.now() - t0 < 3000);
    assert.equal(flat.requirements.length, count);
    assert.equal(flat.requirements[0]!.dependency.declaredLine, undefined);
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
