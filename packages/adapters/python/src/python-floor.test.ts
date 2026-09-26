import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRef } from "@ghostdeps/core";
import { memoryHandle } from "./testing/fs-handle.js";
import { comparePythonVersions, parsePythonFloor, readPythonFloor } from "./python-floor.js";

const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
const read = (files: Record<string, string>) => readPythonFloor(memoryHandle(files), project);

describe("declared Python floor (#300)", () => {
  it("extracts only numeric lower bounds, respecting patch/exclusive and unions", () => {
    const cases: [string, number[] | undefined, boolean?][] = [
      [">=3.10,<4", [3, 10]],
      ["^3.11", [3, 11]],
      ["~=3.10", [3, 10]],
      ["==3.12.*", [3, 12]],
      [">3.11,<=3.13", [3, 11], true],
      [">=3.12.1,!=3.12.2", [3, 12, 1]],
      [">=3.9,<3.10 || >=3.11,<4", [3, 9]],
      ["<3.11", undefined],
      ["!=3.10", undefined],
      ["*", undefined],
      ["3.11 || <3.10", undefined],
      ["3.11foo", undefined],
      ["3.9|3.10", undefined],
      [">=3.11,<3.10", undefined],
      [">=3.11,!=3.11", undefined],
    ];
    for (const [text, version, exclusive = false] of cases)
      assert.deepEqual(parsePythonFloor(text), version ? { version, exclusive } : undefined, text);
    assert.ok(comparePythonVersions([3, 10], [3, 9]) > 0);
    assert.ok(comparePythonVersions([3, 12, 1], [3, 12]) > 0);
  });
  it("uses PEP 621, then Poetry, then setup.py, then setup.cfg", async () => {
    const files = {
      "pyproject.toml":
        '[project]\nrequires-python = ">=3.10,<4"\n[tool.poetry.dependencies]\npython = "^3.11"\n',
      "setup.py": '    python_requires=">=3.12",\n',
      "setup.cfg": "[options]\npython_requires = >=3.13\n",
    };
    assert.deepEqual(await read(files), {
      status: "declared",
      version: [3, 10],
      exclusive: false,
      constraint: ">=3.10,<4",
      declaredIn: "pyproject.toml",
      line: 2,
      evidence: [],
    });
    assert.deepEqual(
      await read({ ...files, "pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.11"\n' }),
      {
        status: "declared",
        version: [3, 11],
        exclusive: false,
        constraint: "^3.11",
        declaredIn: "pyproject.toml",
        line: 2,
        evidence: [],
      },
    );
    assert.equal(
      (await read({ "setup.py": files["setup.py"], "setup.cfg": files["setup.cfg"] })).status,
      "declared",
    );
    assert.equal((await read({ "setup.cfg": files["setup.cfg"] })).status, "declared");
  });
  it("ignores comments, unrelated assignments and other calls in setup.py", async () => {
    for (const script of [
      'setup(name="x") # python_requires=">=3.10"\n',
      'python_requires=">=3.12"\n',
      'dict(python_requires=">=3.12")\n',
    ])
      assert.deepEqual(
        await read({ "setup.py": script }),
        { status: "absent", evidence: [] },
        script,
      );
  });
  it("reads inline setup.py literals and multiline setup.cfg specifiers", async () => {
    const inline = await read({ "setup.py": 'setup(name="x", python_requires=">=3.10")\n' });
    assert.deepEqual(inline, {
      status: "declared",
      version: [3, 10],
      exclusive: false,
      constraint: ">=3.10",
      declaredIn: "setup.py",
      line: 1,
      evidence: [],
    });
    const multiline = await read({
      "setup.cfg": "[options]\npython_requires =\n    >=3.10,\n    <4\n",
    });
    assert.deepEqual(multiline, {
      status: "declared",
      version: [3, 10],
      exclusive: false,
      constraint: ">=3.10,<4",
      declaredIn: "setup.cfg",
      line: 2,
      evidence: [],
    });
  });
  it("does not declare floors from contradictory exact or compatible ranges", async () => {
    for (const value of ["==3.11,>3.11", "^3.11,>=4", "~3.10,>=3.11", "~=3.10,>=4"]) {
      assert.equal(parsePythonFloor(value), undefined, value);
      const result = await read({ "pyproject.toml": `[project]\nrequires-python = "${value}"\n` });
      assert.equal(result.status, "unparsed", value);
    }
  });
  it("locates quoted TOML project and key provenance", async () => {
    const result = await read({ "pyproject.toml": '["project"]\n"requires-python" = ">=3.11"\n' });
    assert.equal(result.status, "declared");
    assert.equal(result.status === "declared" ? result.line : undefined, 2);
  });
  it("does not infer a floor from classifiers, CI, or an upper-only declaration", async () => {
    const absent = await read({
      "pyproject.toml": '[project]\nclassifiers = ["Programming Language :: Python :: 3.12"]\n',
      ".github/workflows/ci.yml": "python-version: 3.12",
    });
    assert.equal(absent.status, "absent");
    const upper = await read({
      "pyproject.toml": '[project]\nrequires-python = "<3.12"\n',
      "setup.cfg": "[options]\npython_requires = >=3.11\n",
    });
    assert.equal(upper.status, "unparsed");
    assert.equal(upper.evidence[0]?.line, 2);
  });
  it("reports the unparsed floor in detection evidence, not a made-up runtime", async () => {
    const { detectPython } = await import("./detect.js");
    const detected = await detectPython({
      repository: memoryHandle({
        "pyproject.toml": '[project]\nrequires-python = "<3.11"\n',
        "app.py": "print(1)",
      }),
      network: { mode: "offline" },
    });
    assert.ok(
      detected.evidence.some(
        (e) => e.kind === "python-floor-unparsed" && e.file === "pyproject.toml" && e.line === 2,
      ),
    );
  });
  it("fails closed on an unreadable or malformed selected source", async () => {
    const malformed = await read({
      "pyproject.toml": '[project\nrequires-python = ">=3.11"\n',
      "setup.cfg": "[options]\npython_requires = >=3.10\n",
    });
    assert.equal(malformed.status, "unparsed");
    assert.equal(malformed.evidence[0]?.kind, "python-floor-unparsed");
  });
  it("distinguishes absent from unparsed and falls back from setup.py with evidence", async () => {
    assert.deepEqual(await read({ "setup.py": 'setup(name="x")\n' }), {
      status: "absent",
      evidence: [],
    });
    const unparsed = await read({ "pyproject.toml": '[project]\nrequires-python = "<3.11"\n' });
    assert.equal(unparsed.status, "unparsed");
    assert.equal(unparsed.evidence[0]?.line, 2);
    const fallback = await read({
      "setup.py": "setup(\n    python_requires=get_python_floor(),\n)\n",
      "setup.cfg": "[options]\npython_requires = >=3.11\n",
    });
    assert.equal(fallback.status, "declared");
    assert.deepEqual(fallback.status === "declared" ? fallback.version : [], [3, 11]);
    assert.equal(fallback.evidence[0]?.file, "setup.py");
    assert.equal(fallback.evidence[0]?.line, 2);
  });
});
