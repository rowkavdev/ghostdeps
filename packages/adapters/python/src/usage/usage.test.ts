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

  it("credits aliased importlib, import_module and __import__ calls", () => {
    const dyn = (src: string) =>
      extractPythonImports(src)
        .imports.filter((i) => i.form === "dynamic")
        .map((i) => i.module);
    assert.deepEqual(dyn('import importlib as il\nil.import_module("x")\n'), ["x"]);
    assert.deepEqual(dyn('from importlib import import_module as im\nim("y")\n'), ["y"]);
    assert.deepEqual(dyn('from importlib import __import__ as imp\nimp("z")\n'), ["z"]);
    // A relative __import__ level is still never an external dependency.
    assert.deepEqual(
      dyn('from importlib import __import__ as imp\nimp("z", None, None, [], 1)\n'),
      [],
    );
    // Attribute access on something else, or a rebound alias, is not credited.
    assert.deepEqual(dyn('import importlib as il\nobj.il.import_module("x")\n'), []);
    assert.deepEqual(dyn('import importlib as il\nil = other\nil.import_module("x")\n'), []);
    assert.deepEqual(dyn('from importlib import import_module as im\nim = fake\nim("y")\n'), []);
    // Unaliased names and plain calls without an alias import are unchanged.
    assert.deepEqual(dyn('im("y")\n'), []);
  });

  it("drops an importlib alias that is rebound anywhere in the file", () => {
    const dyn = (src: string) =>
      extractPythonImports(src)
        .imports.filter((i) => i.form === "dynamic")
        .map((i) => i.module);
    const mod = "import importlib as il\n";
    const fn = "from importlib import import_module as im\n";
    const call = 'il.import_module("x")\n';
    const fcall = 'im("y")\n';
    const moduleCases = [
      "def f(il):\n    pass\n",
      "def f(a, *, il):\n    pass\n",
      "async def f(*il):\n    pass\n",
      "g = lambda il: il\n",
      "for il in items:\n    pass\n",
      "with open(p) as il:\n    pass\n",
      "try:\n    pass\nexcept E as il:\n    pass\n",
      "import numpy as il\n",
      "from x import y as il\n",
      "il, x = 1, 2\n",
      "x, il = 1, 2\n",
      "x = il = 1\n",
      "il: int = 1\n",
      "(il := 3)\n",
      "if x:\n    il = 2\n",
      "global il\n",
      "del il\n",
      "class il:\n    pass\n",
      "def il(x):\n    pass\n",
    ];
    for (const rebind of moduleCases) {
      assert.deepEqual(dyn(mod + rebind + call), [], rebind);
    }
    const functionCases = [
      "def f(im):\n    pass\n",
      "g = lambda im: im\n",
      "from other import thing as im\n",
      "import numpy as im\n",
      "def im(x):\n    pass\n",
      "class im:\n    pass\n",
      "im, x = 1, 2\n",
      "x = im = 1\n",
      "im: int = 1\n",
      "(im := 3)\n",
      "for im in items:\n    pass\n",
      "del im\n",
    ];
    for (const rebind of functionCases) {
      assert.deepEqual(dyn(fn + rebind + fcall), [], rebind);
    }
    // A second from-import that rebinds the alias drops it too.
    assert.deepEqual(dyn(fn + "from other import thing as im\n" + fcall), []);
    // Controls: an unrelated name, a repeated identical alias import, a mixed import.
    assert.deepEqual(dyn(mod + "def f(other):\n    pass\n" + call), ["x"]);
    assert.deepEqual(dyn(mod + mod + call), ["x"]);
    assert.deepEqual(dyn(fn + "from importlib import import_module as im\n" + fcall), ["y"]);
  });

  it("scopes importlib aliases to the function that imports them", () => {
    const dyn = (src: string) =>
      extractPythonImports(src)
        .imports.filter((i) => i.form === "dynamic")
        .map((i) => i.module);
    // Valid: used in the same function, and in a function nested inside it.
    assert.deepEqual(
      dyn('def f():\n    import importlib as il\n    il.import_module("requests")\n'),
      ["requests"],
    );
    assert.deepEqual(
      dyn('def f():\n    from importlib import import_module as im\n    im("requests")\n'),
      ["requests"],
    );
    assert.deepEqual(
      dyn(
        'def f():\n    import importlib as il\n    def g():\n        il.import_module("requests")\n',
      ),
      ["requests"],
    );
    // A module-level alias is visible inside functions.
    assert.deepEqual(dyn('import importlib as il\ndef f():\n    il.import_module("x")\n'), ["x"]);
    // Invalid: the alias is local to f, so module-level or sibling use is not credited.
    assert.deepEqual(
      dyn('def f():\n    import importlib as il\nil.import_module("requests")\n'),
      [],
    );
    assert.deepEqual(
      dyn('def f():\n    from importlib import import_module as im\nim("requests")\n'),
      [],
    );
    assert.deepEqual(
      dyn('def f():\n    import importlib as il\ndef g():\n    il.import_module("requests")\n'),
      [],
    );
    // A class-body alias is not visible inside its methods.
    assert.deepEqual(
      dyn(
        'class C:\n    import importlib as il\n    def m(self):\n        il.import_module("requests")\n',
      ),
      [],
    );
    // A local rebinding inside the defining function still drops the alias.
    assert.deepEqual(
      dyn(
        'def f():\n    import importlib as il\n    il = other\n    il.import_module("requests")\n',
      ),
      [],
    );
  });

  it("uses the nearest importlib alias binding of a name", () => {
    const dyn = (src: string) =>
      extractPythonImports(src)
        .imports.filter((i) => i.form === "dynamic")
        .map((i) => i.module);
    const outerFn = "from importlib import import_module as im\n";
    const outerDunder = "from importlib import __import__ as im\n";
    // Inner __import__ shadows the outer import_module: a relative level is not credited.
    assert.deepEqual(
      dyn(
        outerFn +
          'def f():\n    from importlib import __import__ as im\n    im("requests", None, None, [], 1)\n',
      ),
      [],
    );
    // Absolute use of the inner __import__ is still credited.
    assert.deepEqual(
      dyn(outerFn + 'def f():\n    from importlib import __import__ as im\n    im("requests")\n'),
      ["requests"],
    );
    // Reverse: inner import_module shadows the outer __import__, so the level is just an argument.
    assert.deepEqual(
      dyn(
        outerDunder +
          'def f():\n    from importlib import import_module as im\n    im("requests", 1)\n',
      ),
      ["requests"],
    );
    // The outer binding still applies outside the inner function.
    assert.deepEqual(
      dyn(
        outerDunder +
          'def f():\n    from importlib import import_module as im\nim("requests", None, None, [], 1)\n',
      ),
      [],
    );
    assert.deepEqual(
      dyn(
        outerFn +
          'def f():\n    from importlib import __import__ as im\nim("requests", None, None, [], 1)\n',
      ),
      ["requests"],
    );
  });

  it("keeps a one-line def or class suite scope across semicolons", () => {
    const dyn = (src: string) =>
      extractPythonImports(src)
        .imports.filter((i) => i.form === "dynamic")
        .map((i) => i.module);
    // Local import on the suite's line, used outside: not credited.
    assert.deepEqual(
      dyn('def f(): pass; import importlib as il\nil.import_module("requests")\n'),
      [],
    );
    assert.deepEqual(
      dyn('async def f(): pass; import importlib as il\nil.import_module("requests")\n'),
      [],
    );
    assert.deepEqual(
      dyn('def f(): pass; from importlib import import_module as im\nim("requests")\n'),
      [],
    );
    assert.deepEqual(
      dyn('class C: pass; from importlib import import_module as im\nim("requests")\n'),
      [],
    );
    assert.deepEqual(
      dyn('class C: pass; import importlib as il\nil.import_module("requests")\n'),
      [],
    );
    // Same-line use after the local import is credited.
    assert.deepEqual(dyn('def f(): import importlib as il; il.import_module("requests")\n'), []);
    assert.deepEqual(dyn('def f(): pass; import importlib as il; il.import_module("requests")\n'), [
      "requests",
    ]);
    assert.deepEqual(
      dyn('async def f(): pass; from importlib import import_module as im; im("requests")\n'),
      ["requests"],
    );
    // A statement on the next line is back in the outer scope.
    assert.deepEqual(dyn('def f(): pass\nimport importlib as il\nil.import_module("requests")\n'), [
      "requests",
    ]);
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

it("marks parenthesized TYPE_CHECKING guards type-only without matching other conditions", () => {
  const imports = extractPythonImports(
    [
      "if (TYPE_CHECKING):",
      "    import pandas",
      "if ((typing.TYPE_CHECKING)): import numpy; import yaml",
      "import requests",
      "if (TYPE_CHECKING) or enabled: import flask",
      "if (TYPE_CHECKING, enabled): import httpx",
    ].join("\n"),
  ).imports;
  assert.deepEqual(
    imports.map((imp) => [imp.module, imp.typeOnly]),
    [
      ["pandas", true],
      ["numpy", true],
      ["yaml", true],
      ["requests", false],
      ["flask", false],
      ["httpx", false],
    ],
  );
});

it("keeps the outer TYPE_CHECKING guard after nested guarded blocks end", () => {
  const source = [
    "from typing import TYPE_CHECKING",
    "if TYPE_CHECKING:",
    "    if (typing.TYPE_CHECKING):",
    "        import pandas",
    "        if TYPE_CHECKING:",
    "            import scipy",
    "        import matplotlib",
    "    import numpy",
    "    if enabled:",
    "        import yaml",
    "    else:",
    "        import tomli",
    "else:",
    "    import requests",
    "import httpx",
  ].join("\n");
  assert.deepEqual(
    extractPythonImports(source).imports.map((imp) => [imp.module, imp.typeOnly]),
    [
      ["typing", false],
      ["pandas", true],
      ["scipy", true],
      ["matplotlib", true],
      ["numpy", true],
      ["yaml", true],
      ["tomli", true],
      ["requests", false],
      ["httpx", false],
    ],
  );
});

it("handles CR, LF and CRLF physical newlines identically", () => {
  const lines = [
    "from typing import TYPE_CHECKING",
    "# comment before imports",
    "if TYPE_CHECKING:",
    "    import pandas",
    "import requests",
    "from numpy import (",
    "    array,",
    ")",
    "import \\",
    "    yaml",
  ];
  const expected = extractPythonImports(lines.join("\n")).imports;
  for (const newline of ["\r", "\r\n"]) {
    assert.deepEqual(extractPythonImports(lines.join(newline)).imports, expected);
  }
});

it("ignores leading form feeds while measuring Python indentation", () => {
  const source = "if TYPE_CHECKING:\n\f    import pandas\n\f    import numpy\n\fimport requests\n";
  assert.deepEqual(
    extractPythonImports(source).imports.map(({ module, conditional, typeOnly }) => [
      module,
      conditional,
      typeOnly,
    ]),
    [
      ["pandas", true, true],
      ["numpy", true, true],
      ["requests", false, false],
    ],
  );
});

it("resets indentation columns at a form feed after spaces or tabs", () => {
  const source = [
    "if TYPE_CHECKING:",
    "    import pandas",
    "    \fimport requests",
    "if TYPE_CHECKING:",
    "    import numpy",
    "\t\fimport httpx",
    "if TYPE_CHECKING:",
    "    \f    import yaml",
    "import flask",
  ].join("\n");
  assert.deepEqual(
    extractPythonImports(source).imports.map(({ module, conditional, typeOnly }) => [
      module,
      conditional,
      typeOnly,
    ]),
    [
      ["pandas", true, true],
      ["requests", false, false],
      ["numpy", true, true],
      ["httpx", false, false],
      ["yaml", true, true],
      ["flask", false, false],
    ],
  );
});

it("does not credit a literal prefix of a computed dynamic import argument", () => {
  const source = [
    'importlib.import_module("requests" + suffix)',
    '__import__("numpy".upper())',
    'importlib.import_module("yaml" if flag else "tomli")',
    'importlib.import_module("http" "x")',
    'importlib.import_module("pandas")',
    '__import__("scipy", globals(), locals())',
    'importlib.import_module("matplotlib", package="app")',
  ].join("\n");
  assert.deepEqual(
    extractPythonImports(source).imports.map(({ module }) => module),
    ["pandas", "scipy", "matplotlib"],
  );
});

it("reads literal name keyword arguments to Python dynamic import functions", () => {
  const source = [
    'importlib.import_module(name="yaml")',
    '__import__(name="requests", fromlist=["get"])',
    'import_module(name = "numpy", package="app")',
    'importlib.import_module(name="pandas" + suffix)',
    "__import__(name=module)",
    'importlib.import_module(package="scipy")',
  ].join("\n");
  assert.deepEqual(
    extractPythonImports(source).imports.map(({ module }) => module),
    ["yaml", "requests", "numpy"],
  );
});

it("does not normalize whitespace in dynamic import module strings", () => {
  const source = [
    'importlib.import_module(" requests ")',
    '__import__("numpy\\t")',
    'importlib.import_module("PIL . Image")',
    'importlib.import_module("yaml")',
    '__import__("PIL.Image")',
  ].join("\n");
  assert.deepEqual(
    extractPythonImports(source).imports.map(({ module, form }) => [module, form]),
    [
      ["yaml", "dynamic"],
      ["PIL.Image", "dynamic"],
    ],
  );
});

it("does not credit bytes literals as dynamic import module names", () => {
  const source = [
    '__import__(b"requests")',
    'importlib.import_module(rb"numpy")',
    '__import__(Br"scipy")',
    '__import__(B"pandas")',
    '__import__(r"yaml")',
    'importlib.import_module("PIL.Image")',
  ].join("\n");
  assert.deepEqual(modules(source), ["yaml", "PIL.Image"]);
  assert.deepEqual(splitPythonStatements('__import__(b"requests")').strings, ["requests"]);
});

describe("TYPE_CHECKING aliases", () => {
  const typeOnly = (source: string) =>
    Object.fromEntries(
      extractPythonImports(source)
        .imports.filter(
          (i) =>
            i.module !== "typing" && i.module !== "os" && i.module !== "other" && i.module !== "x",
        )
        .map((i) => [i.module, i.typeOnly]),
    );

  it("treats guards through an aliased flag or an aliased typing module as type-only", () => {
    assert.deepEqual(
      typeOnly(
        "from typing import TYPE_CHECKING as TC\nif TC:\n    import pandas\nimport requests\n",
      ),
      { pandas: true, requests: false },
    );
    assert.deepEqual(typeOnly("import typing as t\nif t.TYPE_CHECKING:\n    import pandas\n"), {
      pandas: true,
    });
    assert.deepEqual(
      typeOnly("from typing import Any, TYPE_CHECKING as TC\nif (TC): import pandas\n"),
      { pandas: true },
    );
    assert.deepEqual(
      typeOnly("import os, typing as t\nif t . TYPE_CHECKING:\n    import pandas\n"),
      { pandas: true },
    );
  });

  it("does not trust an alias that was rebound, shadowed or never bound to typing", () => {
    const head = "from typing import TYPE_CHECKING as TC\n";
    for (const rebind of [
      "TC = False\n",
      "TC: bool = False\n",
      "a, TC = 1, 2\n",
      "import os as TC\n",
      "from other import TC\n",
      "def TC():\n    return 1\n",
      "(a, TC) = (1, True)\n",
      "[TC] = [True]\n",
      "*TC, a = [True, 1]\n",
      "a = TC = False\n",
      "[a, *TC] = [1, True]\n",
      "(a, (b, TC)) = (1, (2, True))\n",
      "TC += 1\n",
      "(TC := False)\n",
      "type TC = int\n",
      "with open(f) as TC:\n    pass\n",
      "with open(f) as (a, TC):\n    pass\n",
      "try:\n    pass\nexcept E as TC:\n    pass\n",
      "match v:\n    case TC:\n        pass\n",
      "match v:\n    case [a, TC]:\n        pass\n",
      "match v:\n    case _ as TC:\n        pass\n",
      "for a, TC in x:\n    pass\n",
      "for TC in [True]: pass\n",
      "async for TC in x: pass\n",
      "if (TC := True): pass\n",
      "while (TC := f()): pass\n",
      "with ctx as TC: pass\n",
      "with a as b, c as TC: pass\n",
      "try: pass\nexcept E as TC: pass\n",
      "try: pass\nexcept* E as TC: pass\n",
      "if x: TC = False\n",
      "if x: (a, TC) = (1, 2)\n",
      "if x: pass\nelse: TC = False\n",
      "while x: TC = False\n",
      "if x: import os as TC\n",
      "if x: from other import TC\n",
      "class TC: pass\n",
      "def TC(): pass\n",
      "TC = x = False\n",
      "TC, = [True]\n",
      "TC: bool\nTC = 0\n",
      "global TC\n",
      "if x: del TC\n",
      "match v:\n    case {'k': TC}: pass\n",
      "match v:\n    case X(a=TC): pass\n",
      "for (a, TC) in x:\n    pass\n",
      "from x import *\n",
      "del TC\n",
      "for TC in range(2):\n    pass\n",
    ]) {
      assert.deepEqual(
        typeOnly(`${head}${rebind}if TC:\n    import pandas\n`),
        { pandas: false },
        rebind,
      );
    }
    assert.deepEqual(
      typeOnly("from other import TYPE_CHECKING as TC\nif TC:\n    import pandas\n"),
      { pandas: false },
    );
    assert.deepEqual(
      typeOnly("if TC:\n    import pandas\nfrom typing import TYPE_CHECKING as TC\n"),
      { pandas: false },
    );
    assert.deepEqual(
      typeOnly("def f():\n    from typing import TYPE_CHECKING as TC\nif TC:\n    import pandas\n"),
      { pandas: false },
    );
    assert.deepEqual(
      typeOnly("import typing as t\nt = object()\nif t.TYPE_CHECKING:\n    import pandas\n"),
      { pandas: false },
    );
    assert.deepEqual(typeOnly("import typing as t\nif u.TYPE_CHECKING:\n    import pandas\n"), {
      pandas: false,
    });
  });

  it("does not trust an alias inside a function or class scope", () => {
    const head = "from typing import TYPE_CHECKING as TC\nimport typing as t\n";
    for (const body of [
      "def f(TC):\n    if TC:\n        import pandas\n",
      "def f(t):\n    if t.TYPE_CHECKING:\n        import pandas\n",
      "def f(*, TC=False):\n    if TC:\n        import pandas\n",
      "g = lambda TC: 1\ndef f():\n    if TC:\n        import pandas\n",
      "def f():\n    if TC:\n        import pandas\n    TC = 1\n",
      "class C:\n    if TC:\n        import pandas\n",
      "def f():\n    if TC: import pandas\n",
    ]) {
      assert.deepEqual(typeOnly(`${head}${body}`), { pandas: false }, body);
    }
  });

  it("lets the last binding in one import statement win", () => {
    assert.deepEqual(
      typeOnly("import typing as t, other as t\nif t.TYPE_CHECKING:\n    import pandas\n"),
      { pandas: false },
    );
    assert.deepEqual(
      typeOnly("from typing import TYPE_CHECKING as TC, Any as TC\nif TC:\n    import pandas\n"),
      { pandas: false },
    );
    assert.deepEqual(
      typeOnly(
        "from typing import TYPE_CHECKING as TC, TYPE_CHECKING as TC2\nif TC2:\n    import pandas\n",
      ),
      { pandas: true },
    );
    assert.deepEqual(
      typeOnly("import other as t, typing as t\nif t.TYPE_CHECKING:\n    import pandas\n"),
      { pandas: true },
    );
    assert.deepEqual(
      typeOnly(
        "from other import TC, typing\nfrom typing import TYPE_CHECKING as TC\nif TC:\n    import pandas\n",
      ),
      { pandas: true },
    );
  });

  it("trusts a re-established alias", () => {
    assert.deepEqual(
      typeOnly(
        "from typing import TYPE_CHECKING as TC\nTC = False\nfrom typing import TYPE_CHECKING as TC\nif TC:\n    import pandas\n",
      ),
      { pandas: true },
    );
  });
});

it("does not credit unrelated methods named like dynamic import functions", () => {
  const source = [
    'obj.import_module("requests")',
    'obj . import_module("requests")',
    'obj . importlib . import_module("requests")',
    'obj.__import__("numpy")',
    'myimportlib.import_module("scipy")',
    'obj.importlib.import_module("pandas")',
    'importlib.import_module("yaml")',
    'import_module("flask")',
    '__import__("httpx")',
    'builtins.__import__("toml")',
    '__builtins__.__import__("attrs")',
    'importlib . import_module("rich")',
    'builtins . __import__("click")',
    'importlib.__import__("jinja2")',
  ].join("\n");
  assert.deepEqual(modules(source), [
    "yaml",
    "flask",
    "httpx",
    "toml",
    "attrs",
    "rich",
    "click",
    "jinja2",
  ]);
});

it("invalidates TYPE_CHECKING aliases rebound through NFKC-equivalent identifiers", () => {
  for (const source of [
    "from typing import TYPE_CHECKING as K\n\u212a = True\nif K:\n    import pandas\n",
    "from typing import TYPE_CHECKING as \u212a\n\u212a = True\nif \u212a:\n    import pandas\n",
    "import typing as K\n\u212a = object()\nif K.TYPE_CHECKING:\n    import pandas\n",
  ]) {
    assert.equal(
      extractPythonImports(source).imports.find((i) => i.module === "pandas")?.typeOnly,
      false,
      source,
    );
  }
});

it("does not credit a relative __import__ level as an external dependency", () => {
  const source = [
    '__import__("rel_kw", level=1)',
    '__import__("rel_kw2", level = 2)',
    '__import__("rel_pos", globals(), locals(), [], 1)',
    '__import__("rel_hex", globals(), locals(), [], 0x1)',
    '__import__("rel_paren", globals(), locals(), [], (1))',
    'builtins.__import__("rel_b", level=1)',
    'importlib.__import__("rel_i", None, None, None, 3)',
    '__import__(name="rel_named", level=1)',
    '__import__("rel_plus", level=+1)',
    '__import__("rel_plus_space", level = + 2)',
    '__import__("rel_plus_paren", level=(+1))',
    '__import__("rel_true", level=True)',
    '__import__("rel_true_pos", globals(), locals(), [], True)',
    '__import__("abs_false", level=False)',
    '__import__("abs_plus_zero", level=+0)',
    '__import__("abs_neg", level=-1)',
    '__import__("abs_not_bool", level=true)',
    '__import__("abs_zero", level=0)',
    '__import__("abs_zero_pos", globals(), locals(), [], 0)',
    '__import__("abs_plain")',
    '__import__("abs_four", globals(), locals(), [])',
    '__import__("abs_unknown", level=lvl)',
    '__import__("abs_unknown_pos", globals(), locals(), [], n + 1)',
    '__import__("abs_star", *args)',
    '__import__("abs_kw", fromlist=["x"], level=0)',
    '__import__("abs_nested", f(level=1))',
    'importlib.import_module(".rel_mod", package="app")',
    'importlib.import_module(".rel_mod2", "app")',
    'importlib.import_module("abs_mod", package="app")',
  ].join("\n");
  assert.deepEqual(modules(source), [
    "abs_false",
    "abs_plus_zero",
    "abs_neg",
    "abs_not_bool",
    "abs_zero",
    "abs_zero_pos",
    "abs_plain",
    "abs_four",
    "abs_unknown",
    "abs_unknown_pos",
    "abs_star",
    "abs_kw",
    "abs_nested",
    "abs_mod",
  ]);
});
