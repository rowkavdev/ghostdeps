import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { analyseDirectory, createDefaultPolicy } from "@ghostdeps/core";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { FIXTURES_ROOT } from "../testing/fs-handle.js";
import { createPythonAdapter } from "../adapter.js";
import { memoryHandle } from "../testing/fs-handle.js";
import { extractPythonImports } from "./imports.js";
import { splitPythonStatements } from "./lexer.js";
import { buildRequirementLine, findPythonUsage } from "./scan.js";

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

  it("returns no usages (never a verdict) for an unimported dependency", async () => {
    assert.deepEqual(await findPythonUsage(ctx(), dep("unused-lib")), []);
  });

  it("gives build-system requirements declaration-site usage (#268 ruling)", async () => {
    assert.deepEqual(await findPythonUsage(ctx(), dep("hatchling", "build")), [
      {
        dependency: "hatchling",
        file: "pyproject.toml",
        line: 5,
        form: "unknown",
        via: "config",
        symbols: [],
      },
    ]);
  });
});

describe("buildRequirementLine", () => {
  it("finds the requirement line inside [build-system], normalising names", () => {
    const text =
      '[project]\nname = "a"\ndependencies = ["poetry-core"]\n\n[build-system]\nrequires = [\n  "setuptools>=68",\n  "Poetry_Core>=1.9",\n]\n[tool.x]\ny = "poetry-core"\n';
    assert.equal(buildRequirementLine(text, "poetry-core"), 8);
    assert.equal(buildRequirementLine(text, "setuptools"), 7);
    // Not listed: falls back to the requires line.
    assert.equal(buildRequirementLine(text, "wheel"), 6);
    assert.equal(buildRequirementLine("[project]\n", "x"), 1);
  });
});

describe("no-imports notes never fire for build-system requirements (#268)", () => {
  for (const scenario of ["poetry-basic", "poetry-lock-graph", "uv-lock-graph", "pep621-uv"]) {
    it(`python/${scenario}`, async () => {
      const result = await analyseDirectory(path.join(FIXTURES_ROOT, "python", scenario), {
        adapters: [createPythonAdapter()],
        network: { mode: "offline" },
        recommend: createDefaultPolicy({}),
      });
      const build = new Set(
        result.dependencies.filter((d) => d.kind === "build").map((d) => d.name),
      );
      assert.ok(build.size > 0, `${scenario}: fixture declares a build-system requirement`);
      const bad = result.findings.filter(
        (f) =>
          f.dependency !== undefined &&
          build.has(f.dependency) &&
          f.rule !== undefined &&
          /no-imports|unused/.test(f.rule),
      );
      assert.deepEqual(bad, [], `${scenario}: build requirement flagged`);
      // And no unused verdicts for Python at all in M2.
      assert.ok(!result.findings.some((f) => f.rule === "unused"));
    });
  }
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

it("keeps ASCII module imports with legal Unicode local aliases", () => {
  const result = extractPythonImports('import yaml as café\ncafé.safe_load("x")\n');
  assert.equal(result.imports[0]?.module, "yaml");
  assert.equal(result.imports[0]?.local, "café");
  assert.ok(result.attributes.get("café")?.has("safe_load"));
});

it("matches NFKC-equivalent Python alias spellings", () => {
  const result = extractPythonImports('import yaml as K\nK.safe_load("x")\n');
  assert.equal(result.imports[0]?.local, "K");
  assert.ok(result.attributes.get("K")?.has("safe_load"));
});

describe("one-line clause bodies", () => {
  it("keeps imports in async def/with/for and loop one-liners and marks one-line TYPE_CHECKING imports type-only", () => {
    const { imports } = extractPythonImports(
      [
        "from typing import TYPE_CHECKING",
        "async def f(): import aa",
        "for x in y: import bb",
        "while z: import cc",
        "if TYPE_CHECKING: import yaml",
        "if typing.TYPE_CHECKING: import tomli",
        "if other: import plain",
        "import last",
      ].join("\n"),
    );
    const byModule = new Map(imports.map((i) => [i.module, i]));
    for (const name of ["aa", "bb", "cc", "plain"]) {
      assert.equal(byModule.get(name)?.conditional, true, name);
      assert.equal(byModule.get(name)?.typeOnly, false, name);
    }
    for (const name of ["yaml", "tomli"]) {
      assert.equal(byModule.get(name)?.conditional, true, name);
      assert.equal(byModule.get(name)?.typeOnly, true, name);
    }
    assert.equal(byModule.get("last")?.typeOnly, false);
  });
});

it("finds compound header separators after nested slice colons", () => {
  const { imports } = extractPythonImports(
    "if values[1:]: import yaml\nfor value in values[::2]: import tomli\nasync def f(a: int): import loguru\n",
  );
  assert.deepEqual(
    imports.map((imp) => imp.module),
    ["yaml", "tomli", "loguru"],
  );
});

it("does not mistake walrus assignment for a compound clause separator", () => {
  const { imports } = extractPythonImports(
    "if value := get_value(): import yaml\nwhile value := next_value(): import tomli\n",
  );
  assert.deepEqual(
    imports.map((imp) => imp.module),
    ["yaml", "tomli"],
  );
});

describe("match statement case bodies", () => {
  it("finds imports in one-line case bodies, including guarded and structured patterns", () => {
    const found = modules(
      [
        "match command:",
        '  case "json": import json',
        "  case [1, *rest] if verbose: import sys",
        '  case {"level": level}: import logging',
        "  case _:",
        "    import os",
        "",
      ].join("\n"),
    );
    for (const want of ["json", "sys", "logging", "os"]) {
      assert.ok(found.includes(want), `missing ${want} in ${JSON.stringify(found)}`);
    }
  });
});

describe("bare lambda clause tests", () => {
  it("splits the clause header after a bare lambda colon", () => {
    const found = modules(
      [
        "if lambda x: x: import os",
        "while lambda: False: import sys",
        "def f(x=lambda: 1): import json",
        "if lambda x: lambda y: x: import re",
      ].join("\n"),
    );
    for (const want of ["os", "sys", "json", "re"]) {
      assert.ok(found.includes(want), `missing ${want} in ${JSON.stringify(found)}`);
    }
  });
});

it("does not treat a lambda suffix inside an identifier as a lambda keyword", () => {
  assert.deepEqual(modules("if notlambda: import yaml\nif lambda_value: import tomli\n"), [
    "yaml",
    "tomli",
  ]);
});

it("keeps semicolon-separated inline suite imports conditional and type-only", () => {
  const source = [
    "if TYPE_CHECKING: import yaml; import tomli",
    "import requests",
    "if flag: import numpy; import pandas",
    "import flask",
    "try: import rich; import click",
    "except ImportError: pass",
    "import httpx",
  ].join("\n");
  assert.deepEqual(
    extractPythonImports(source).imports.map((imp) => [imp.module, imp.conditional, imp.typeOnly]),
    [
      ["yaml", true, true],
      ["tomli", true, true],
      ["requests", false, false],
      ["numpy", true, false],
      ["pandas", true, false],
      ["flask", false, false],
      ["rich", true, false],
      ["click", true, false],
      ["httpx", false, false],
    ],
  );
});

it("reads Unicode module and imported names with Python's static NFKC normalization", () => {
  const imports = extractPythonImports(
    "import café as c\nfrom café.sub import Résumé\nimport ｒｅｑｕｅｓｔｓ as r\nfrom ｒｅｑｕｅｓｔｓ import ｇｅｔ\nimportlib.import_module('ｒｅｑｕｅｓｔｓ')\n",
  ).imports;
  assert.deepEqual(
    imports.map((imp) => [imp.module, imp.names, imp.form]),
    [
      ["café", [], "static"],
      ["café.sub", ["Résumé"], "static"],
      ["requests", [], "static"],
      ["requests", ["get"], "static"],
      ["ｒｅｑｕｅｓｔｓ", [], "dynamic"],
    ],
  );
});

it("credits an ASCII dependency imported with NFKC-equivalent module spelling", async () => {
  const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
  const context: AdapterContext = {
    repository: memoryHandle({
      "pyproject.toml": '[project]\nname="app"\ndependencies=["requests"]\n',
      "main.py": "import ｒｅｑｕｅｓｔｓ as r\nr.get('url')\n",
    }),
    network: { mode: "offline" },
  };
  assert.ok(
    (
      await findPythonUsage(context, {
        name: "requests",
        kind: "runtime",
        constraint: "",
        declaredIn: "pyproject.toml",
        project,
      })
    ).some((usage) => usage.file === "main.py"),
  );
});
