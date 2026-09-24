import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { createPythonAdapter } from "../adapter.js";
import { memoryHandle } from "../testing/fs-handle.js";
import { extractPythonImports } from "./imports.js";
import { splitPythonStatements } from "./lexer.js";
import { findPythonUsage } from "./scan.js";

const modules = (source: string) => extractPythonImports(source).imports.map((i) => i.module);

describe("splitPythonStatements", () => {
  it("joins bracketed and backslash-continued lines and splits on ;", () => {
    const { statements } = splitPythonStatements(
      "from a import (\n  b,\n  c,\n)\nx = 1; import d\ny = 1 + \\\n  2\n",
    );
    assert.deepEqual(
      statements.map((s) => [s.line, s.text.replace(/\s+/g, " ")]),
      [
        [1, "from a import ( b, c, )"],
        [5, "x = 1"],
        [5, "import d"],
        [6, "y = 1 + 2"],
      ],
    );
  });

  it("blanks comments and strings, keeping string contents", () => {
    const { statements, strings } = splitPythonStatements(
      '"""Docstring:\nimport fake\n"""\nx = rb"import nope"  # import comment\n',
    );
    assert.equal(statements.length, 2);
    assert.ok(statements.every((s) => !/import/.test(s.text)));
    assert.deepEqual(strings, ["Docstring:\nimport fake\n", "import nope"]);
    assert.equal(statements[1]!.line, 4);
  });
});

describe("extractPythonImports", () => {
  it("reads import and from-import forms with aliases", () => {
    const { imports } = extractPythonImports(
      "import os, yaml as y\nimport google.protobuf.message\nfrom PIL import Image, ImageOps as ops\nfrom sklearn.linear_model import *\n",
    );
    assert.deepEqual(
      imports.map((i) => [i.module, i.local ?? null, i.names]),
      [
        ["os", "os", []],
        ["yaml", "y", []],
        ["google.protobuf.message", "google", []],
        ["PIL", null, ["Image", "ImageOps"]],
        ["sklearn.linear_model", null, ["*"]],
      ],
    );
  });

  it("reads multi-line parenthesised imports", () => {
    const { imports } = extractPythonImports(
      "from requests import (\n    get,  # fetch\n    post as p,\n)\n",
    );
    assert.deepEqual(imports[0]?.names, ["get", "post"]);
    assert.equal(imports[0]?.line, 1);
  });

  it("ignores imports inside comments and strings", () => {
    assert.deepEqual(
      modules(
        '# import commented\ns = "import in_string"\nt = """\nfrom x import y\n"""\nimport real\n',
      ),
      ["real"],
    );
  });

  it("skips relative imports as first-party", () => {
    assert.deepEqual(
      modules("from . import sibling\nfrom ..pkg import thing\nfrom .mod import x\n"),
      [],
    );
  });

  it("marks conditional and try/except fallback imports", () => {
    const { imports } = extractPythonImports(
      "try:\n    import ujson as json\nexcept ImportError:\n    import json\nif sys.platform == 'win32': import winreg\ndef f():\n    import lazy\n",
    );
    assert.deepEqual(
      imports.map((i) => [i.module, i.conditional]),
      [
        ["ujson", true],
        ["json", true],
        ["winreg", true],
        ["lazy", true],
      ],
    );
  });

  it("marks TYPE_CHECKING imports type-only until the block ends", () => {
    const { imports } = extractPythonImports(
      "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from pandas import DataFrame\n    import numpy\nimport requests\n",
    );
    assert.deepEqual(
      imports.map((i) => [i.module, i.typeOnly]),
      [
        ["typing", false],
        ["pandas", true],
        ["numpy", true],
        ["requests", false],
      ],
    );
  });

  it("reads importlib.import_module and __import__ string literals", () => {
    const { imports } = extractPythonImports(
      'import importlib\nmod = importlib.import_module("yaml")\nx = __import__(\'PIL.Image\')\nrel = importlib.import_module(".local", __package__)\ndyn = importlib.import_module(name)\n',
    );
    assert.deepEqual(
      imports.map((i) => [i.module, i.form]),
      [
        ["importlib", "static"],
        ["yaml", "dynamic"],
        ["PIL.Image", "dynamic"],
      ],
    );
  });

  it("collects attributes used on imported module names", () => {
    const { attributes } = extractPythonImports(
      'import requests\nimport numpy as np\nr = requests.get("u")\nrequests.post("u")\nnp.array([1])\nobj.requests.nope\n',
    );
    assert.deepEqual([...(attributes.get("requests") ?? [])].sort(), ["get", "post"]);
    assert.deepEqual([...(attributes.get("np") ?? [])], ["array"]);
  });
});

describe("findPythonUsage", () => {
  const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
  const dep = (name: string, kind: Dependency["kind"] = "runtime"): Dependency => ({
    name,
    constraint: "",
    kind,
    declaredIn: "pyproject.toml",
    project,
  });
  const ctx = (): AdapterContext => ({
    repository: memoryHandle({
      "pyproject.toml":
        '[project]\nname = "app"\ndependencies = ["Pillow", "requests", "PyYAML", "pandas", "unused-lib"]\n[build-system]\nrequires = ["hatchling"]\n',
      "app/__init__.py": "",
      "app/main.py":
        'from PIL import Image\nimport requests\nfrom app import util\nfrom typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import pandas\n\ndef go():\n    requests.get("u")\n    return Image\n',
      "app/loader.py":
        'import importlib\nconf = importlib.import_module("yaml")\n# import unused_lib\n',
      "app/util.py": "",
      ".venv/lib/site-packages/x.py": "import requests\n",
      "services/other/pyproject.toml": '[project]\nname = "other"\ndependencies = ["requests"]\n',
      "services/other/main.py": "import requests\n",
    }),
    network: { mode: "offline" },
  });

  it("finds static usage through the name mapping with symbols", async () => {
    const pillow = await findPythonUsage(ctx(), dep("pillow"));
    assert.deepEqual(pillow, [
      {
        dependency: "pillow",
        file: "app/main.py",
        line: 1,
        form: "static",
        via: "import",
        symbols: ["Image"],
      },
    ]);
    const requests = await findPythonUsage(ctx(), dep("requests"));
    // Excluded dirs and the nested project's files are not this project's.
    assert.deepEqual(
      requests.map((u) => [u.file, u.line, u.symbols]),
      [["app/main.py", 2, ["get"]]],
    );
  });

  it("reports dynamic importlib usage and type-only usage", async () => {
    const yaml = await findPythonUsage(ctx(), dep("pyyaml"));
    assert.deepEqual(
      yaml.map((u) => [u.file, u.line, u.form]),
      [["app/loader.py", 2, "dynamic"]],
    );
    const pandas = await findPythonUsage(ctx(), dep("pandas"));
    assert.equal(pandas[0]?.typeOnly, true);
  });

  it("returns no usages (never a verdict) for unimported and build-system deps", async () => {
    assert.deepEqual(await findPythonUsage(ctx(), dep("unused-lib")), []);
    assert.deepEqual(await findPythonUsage(ctx(), dep("hatchling", "build")), []);
  });
});

describe("usage capability semantics (#261)", () => {
  it("declares usageAnalysis but never referenceAnalysis in M2", () => {
    const adapter = createPythonAdapter();
    assert.ok(adapter.capabilities.has("usageAnalysis"));
    assert.equal(typeof adapter.findUsage, "function");
    assert.ok(!adapter.capabilities.has("referenceAnalysis"));
  });

  it("returns the plain-array form, which reads as reference analysis incomplete", async () => {
    const adapter = createPythonAdapter();
    const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
    const result = await adapter.findUsage!(
      {
        repository: memoryHandle({ "pyproject.toml": '[project]\nname = "a"\n', "a.py": "" }),
        network: { mode: "offline" },
      },
      { name: "x", constraint: "", kind: "runtime", declaredIn: "pyproject.toml", project },
    );
    assert.ok(Array.isArray(result));
  });
});
