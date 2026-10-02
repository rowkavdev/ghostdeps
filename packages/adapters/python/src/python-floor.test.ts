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
  it("ignores keyword-looking text inside setup string values", async () => {
    const positive = await read({
      "setup.py": 'setup(name="python_requires=>=3.12", python_requires=">=3.10")\n',
    });
    assert.equal(positive.status, "declared");
    assert.deepEqual(positive.status === "declared" ? positive.version : [], [3, 10]);
    assert.deepEqual(await read({ "setup.py": 'setup(name="python_requires=>=3.12")\n' }), {
      status: "absent",
      evidence: [],
    });
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

it("bounds wildcard equality at the width of its version prefix", async () => {
  for (const value of ["==3.9.2.*,>=3.9.3", "==3.9.2.*,>3.9.3", "==3.*,>=4", "==3.9.*,>=3.10"]) {
    assert.equal(parsePythonFloor(value), undefined, value);
    const result = await read({ "pyproject.toml": `[project]\nrequires-python = "${value}"\n` });
    assert.equal(result.status, "unparsed", value);
  }
  for (const [value, version] of [
    ["==3.9.2.*", [3, 9, 2]],
    ["==3.9.*", [3, 9]],
    ["==3.*", [3]],
    ["==3.*,>=3.12", [3, 12]],
    ["==3.9.2.*,>=3.9.2", [3, 9, 2]],
  ] as const) {
    assert.deepEqual(parsePythonFloor(value), { version, exclusive: false }, value);
  }
});

it("does not read setup.py floor declarations from multiline string contents", async () => {
  for (const quote of ['"""', "'''"]) {
    const docstring = `${quote}Example:\nsetup(python_requires=">=3.12")\n${quote}\n`;
    assert.equal((await read({ "setup.py": docstring })).status, "absent", quote);
    const script = `setup(description=${quote}\npython_requires=">=3.12",\n${quote}, python_requires=">=3.10")`;
    const result = await read({ "setup.py": script });
    assert.equal(result.status, "declared", quote);
    assert.deepEqual(result.status === "declared" ? result.version : [], [3, 10], quote);
    assert.equal(result.status === "declared" ? result.line : undefined, 3, quote);
  }
});

it("reads setup.py floors with every Python physical newline sequence", async () => {
  const lines = [
    "from setuptools import setup",
    '"""Documentation:',
    'setup(python_requires=">=3.12")',
    '"""',
    "setup(",
    '    python_requires=">=3.10",',
    ")",
  ];
  const expected = await read({ "setup.py": lines.join("\n") });
  assert.equal(expected.status, "declared");
  assert.equal(expected.status === "declared" ? expected.line : undefined, 6);
  for (const newline of ["\r", "\r\n"]) {
    assert.deepEqual(
      await read({ "setup.py": lines.join(newline) }),
      expected,
      JSON.stringify(newline),
    );
  }
});

it("ignores whole comment lines while joining setup.cfg floor values", async () => {
  for (const comment of ["# supported range", "; supported range"]) {
    for (const indent of ["", "    "]) {
      const cfg = `[options]\npython_requires =\n${indent}${comment}\n    >=3.10,\n${indent}${comment}\n    <4\npackages = find:\n`;
      const result = await read({ "setup.cfg": cfg });
      assert.equal(result.status, "declared", JSON.stringify([comment, indent]));
      assert.equal(result.status === "declared" ? result.constraint : undefined, ">=3.10,<4");
      assert.equal(result.status === "declared" ? result.line : undefined, 2);
    }
  }
});

it("ends setup.cfg floor values at options with equal or shallower indentation", async () => {
  for (const indent of ["    ", "\t"]) {
    for (const nextIndent of [indent, ""]) {
      const cfg = `[options]\n${indent}python_requires = >=3.10\n${nextIndent}packages = find:\n`;
      const result = await read({ "setup.cfg": cfg });
      assert.equal(result.status, "declared", JSON.stringify([indent, nextIndent]));
      assert.deepEqual(result.status === "declared" ? result.version : [], [3, 10]);
      assert.equal(result.status === "declared" ? result.line : undefined, 2);
    }
    const cfg = `[options]\n${indent}python_requires =\n${indent}  >=3.10,\n${indent}  <4\n${indent}packages = find:\n`;
    const result = await read({ "setup.cfg": cfg });
    assert.equal(result.status, "declared");
    assert.equal(result.status === "declared" ? result.constraint : undefined, ">=3.10,<4");
  }
});

it("accepts colon floor options but preserves setuptools case-sensitive keys", async () => {
  for (const delimiter of ["=", ":"]) {
    const result = await read({ "setup.cfg": `[options]\npython_requires ${delimiter} >=3.10\n` });
    assert.equal(result.status, "declared", delimiter);
    assert.deepEqual(result.status === "declared" ? result.version : [], [3, 10]);
    assert.equal(result.status === "declared" ? result.line : undefined, 2);
    for (const key of ["Python_Requires", "PYTHON_REQUIRES"]) {
      assert.equal(
        (await read({ "setup.cfg": `[options]\n${key} ${delimiter} >=3.10\n` })).status,
        "absent",
        key,
      );
    }
  }
});

it("does not infer setup.cfg floors from differently cased section names", async () => {
  for (const section of ["OPTIONS", "Options"]) {
    const result = await read({ "setup.cfg": `[${section}]\npython_requires = >=3.12\n` });
    assert.equal(result.status, "absent", section);
  }
  const result = await read({
    "setup.cfg": "[OPTIONS]\npython_requires = >=3.12\n[options]\npython_requires = >=3.10\n",
  });
  assert.equal(result.status, "declared");
  assert.deepEqual(result.status === "declared" ? result.version : [], [3, 10]);
  assert.equal(result.status === "declared" ? result.line : undefined, 4);
});

it("keeps setup.cfg floor continuation values across empty lines", async () => {
  for (const blank of ["", "    "]) {
    const cfg = `[options]\npython_requires =\n    >=3.10,\n${blank}\n    <4\npackages = find:\n`;
    const result = await read({ "setup.cfg": cfg });
    assert.equal(result.status, "declared", JSON.stringify(blank));
    assert.equal(result.status === "declared" ? result.constraint : undefined, ">=3.10,<4");
    assert.equal(result.status === "declared" ? result.line : undefined, 2);
    const contradiction = await read({ "setup.cfg": cfg.replace("<4", "<3.10") });
    assert.equal(contradiction.status, "unparsed");
  }
});

it("does not invent setup.cfg floors by stripping inline hash text", async () => {
  for (const tail of [" # note", "#note", " # <4"]) {
    const result = await read({ "setup.cfg": `[options]\npython_requires = >=3.10${tail}\n` });
    assert.equal(result.status, "unparsed", tail);
  }
  const valid = await read({ "setup.cfg": "[options]\npython_requires = >=3.10\n" });
  assert.equal(valid.status, "declared");
});

it("preserves inner spaces in setup.cfg section names", async () => {
  for (const section of [" options ", " options", "options "]) {
    const ignored = await read({ "setup.cfg": `[${section}]\npython_requires = >=3.12\n` });
    assert.equal(ignored.status, "absent", section);
    const real = await read({
      "setup.cfg": `[${section}]\npython_requires = >=3.12\n[options]\npython_requires = >=3.10\n`,
    });
    assert.equal(real.status, "declared", section);
    assert.deepEqual(real.status === "declared" ? real.version : [], [3, 10]);
    assert.equal(real.status === "declared" ? real.line : undefined, 4);
  }
});

it("uses ConfigParser's final closing bracket for setup.cfg section names", async () => {
  for (const header of ["[options]]", "[options] # ]"]) {
    assert.equal(
      (await read({ "setup.cfg": `${header}\npython_requires = >=3.12\n` })).status,
      "absent",
      header,
    );
    const result = await read({
      "setup.cfg": `${header}\npython_requires = >=3.12\n[options]\npython_requires = >=3.10\n`,
    });
    assert.equal(result.status, "declared");
    assert.deepEqual(result.status === "declared" ? result.version : [], [3, 10]);
    assert.equal(result.status === "declared" ? result.line : undefined, 4);
  }
  assert.equal(
    (await read({ "setup.cfg": "[options] # plain comment\npython_requires = >=3.10\n" })).status,
    "declared",
  );
});

it("does not fuse setup.cfg continuation fragments into valid floor tokens", async () => {
  for (const value of [">=3.\n    10", ">=3\n    .10", ">\n    =3.10", ">=3.10\n    <4"]) {
    const result = await read({ "setup.cfg": `[options]\npython_requires = ${value}\n` });
    assert.equal(result.status, "unparsed", value);
  }
  for (const value of [">=3.10,\n    <4", ">=\n    3.10,\n    <4", ">=3.10\n    ,<4"]) {
    const result = await read({ "setup.cfg": `[options]\npython_requires = ${value}\n` });
    assert.equal(result.status, "declared", value);
    assert.deepEqual(result.status === "declared" ? result.version : [], [3, 10], value);
  }
});

it("bounds zero-major caret ranges at the first nonzero component or explicit width", async () => {
  for (const value of ["^0.0.3,>=0.0.4", "^0.0.0,>=0.0.1", "^0.0,>=0.1", "^0,>=1"]) {
    assert.equal(parsePythonFloor(value), undefined, value);
    const result = await read({
      "pyproject.toml": `[tool.poetry.dependencies]\npython = "${value}"\n`,
    });
    assert.equal(result.status, "unparsed", value);
  }
  for (const [value, version] of [
    ["^0.0.3", [0, 0, 3]],
    ["^0.0.0", [0, 0, 0]],
    ["^0.0", [0, 0]],
    ["^0", [0]],
    ["^0.2.3,>=0.2.4", [0, 2, 4]],
    ["^3.10,>=3.12", [3, 12]],
  ] as const) {
    assert.deepEqual(parsePythonFloor(value), { version, exclusive: false }, value);
  }
});

it("reads setup.cfg physical newlines with standalone carriage returns", async () => {
  for (const newline of ["\r", "\r\n", "\n"]) {
    const text = ["[options]", "python_requires = >=3.10,", "    <4", ""].join(newline);
    const result = await read({ "setup.cfg": text });
    assert.equal(result.status, "declared", JSON.stringify(newline));
    assert.deepEqual(result.status === "declared" ? result.version : [], [3, 10]);
    assert.equal(result.status === "declared" ? result.line : undefined, 2);
    assert.equal((await read({ "setup.cfg": text.replace("<4", "<3.10") })).status, "unparsed");
  }
});

it("does not treat setup.cfg continuation header text as a new options section", async () => {
  const cfg = "[metadata]\ndescription = notes\n    [options]\npython_requires = >=3.12\n";
  const result = await read({ "setup.cfg": cfg });
  assert.equal(result.status, "absent");
  const phantomKey = await read({
    "setup.cfg": "[options]\ndescription = notes\n    python_requires = >=3.12\n",
  });
  assert.equal(phantomKey.status, "absent");
  const valid = await read({
    "setup.cfg": "[metadata]\ndescription = notes\n[options]\npython_requires = >=3.10\n",
  });
  assert.equal(valid.status, "declared");
});

it("does not infer a setup.cfg floor after data before the first section", async () => {
  for (const prefix of ["python_requires = >=3.12", "name = demo", "invalid text"]) {
    const result = await read({
      "setup.cfg": `${prefix}\n[options]\npython_requires = >=3.10\n`,
    });
    assert.equal(result.status, "unparsed", prefix);
    assert.equal(result.evidence[0]?.line, 1, prefix);
  }
  const valid = await read({
    "setup.cfg": "# heading\n; note\n\n[options]\npython_requires = >=3.10\n",
  });
  assert.equal(valid.status, "declared");
});

it("does not read a setup.cfg Python floor through a leading UTF-8 BOM", async () => {
  const result = await read({ "setup.cfg": "\uFEFF[options]\npython_requires = >=3.10\n" });
  assert.equal(result.status, "unparsed");
  assert.equal(result.evidence[0]?.line, 1);
  const valid = await read({ "setup.cfg": "[options]\npython_requires = >=3.10\n" });
  assert.equal(valid.status, "declared");
});

it("rejects duplicate setup.cfg sections before or after python_requires", async () => {
  for (const contents of [
    "[options]\n[options]\npython_requires = >=3.10\n",
    "[options]\npython_requires = >=3.10\n[options]\nother = value\n",
    "[options]\npython_requires = >=3.10\n[metadata]\nname = example\n[metadata]\nversion = 1\n",
  ])
    assert.equal((await read({ "setup.cfg": contents })).status, "unparsed", contents);
  assert.equal(
    (
      await read({
        "setup.cfg": "[options]\npython_requires = >=3.10\n[metadata]\nname = example\n",
      })
    ).status,
    "declared",
  );
  assert.equal(
    (
      await read({
        "setup.cfg": "[DEFAULT]\na = 1\n[DEFAULT]\nb = 2\n[options]\npython_requires = >=3.10\n",
      })
    ).status,
    "declared",
  );
});

it("rejects duplicate python_requires in the same setup.cfg section", async () => {
  for (const contents of [
    "[options]\npython_requires = >=3.10\npython_requires = >=3.12\n",
    "[options]\npython_requires = >=3.10\npython_requires: >=3.12\n",
    "[options]\npython_requires = >=3.10,\n  <4\npython_requires = >=3.12\n",
  ])
    assert.equal((await read({ "setup.cfg": contents })).status, "unparsed", contents);
  for (const contents of [
    "[options]\npython_requires = >=3.10\nPython_Requires = >=3.12\n",
    "[DEFAULT]\npython_requires = >=3.9\n[options]\npython_requires = >=3.10\n",
    "[options]\npython_requires = >=3.10\n[other]\npython_requires = >=3.12\n",
  ])
    assert.equal((await read({ "setup.cfg": contents })).status, "declared", contents);
});
