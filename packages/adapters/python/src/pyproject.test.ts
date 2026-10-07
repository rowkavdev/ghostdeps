import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRef } from "@ghostdeps/core";
import { parsePyprojectText } from "./pyproject.js";

const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
const parse = (text: string) => parsePyprojectText(text, project, "pyproject.toml");
const summary = (text: string) =>
  parse(text).requirements.map((r) => ({
    name: r.dependency.name,
    kind: r.dependency.kind,
    constraint: r.dependency.constraint,
    ...(r.groups.length > 0 ? { groups: r.groups } : {}),
    ...(r.extras.length > 0 ? { extras: r.extras } : {}),
  }));

describe("parsePyprojectText: PEP 621 (issue #43)", () => {
  it("reads dependencies, optional extras, groups, build and uv dev deps", () => {
    const text = `
[project]
name = "x"
dependencies = ["httpx>=0.27", "Rich"]

[project.optional-dependencies]
Cli = ["typer[all]>=0.12"]

[dependency-groups]
test = ["pytest>=8", {include-group = "lint"}]
lint = ["ruff"]

[build-system]
requires = ["hatchling"]

[tool.uv]
dev-dependencies = ["mypy"]
`;
    assert.deepEqual(summary(text), [
      { name: "httpx", kind: "runtime", constraint: ">=0.27" },
      { name: "rich", kind: "runtime", constraint: "*" },
      { name: "typer", kind: "optional", constraint: ">=0.12", groups: ["cli"], extras: ["all"] },
      { name: "pytest", kind: "dev", constraint: ">=8", groups: ["test"] },
      { name: "ruff", kind: "dev", constraint: "*", groups: ["lint"] },
      { name: "hatchling", kind: "build", constraint: "*" },
      { name: "mypy", kind: "dev", constraint: "*" },
    ]);
    assert.deepEqual(parse(text).extras, { cli: ["typer"] });
  });

  it("expands self-referencing extras into the members of the extras they request (#741)", () => {
    const result = parse(
      [
        "[project]",
        'name = "My_Pkg"',
        "[project.optional-dependencies]",
        'a = ["numpy"]',
        'b = ["pandas"]',
        'all = ["my-pkg[a,b]"]',
      ].join("\n"),
    );
    assert.deepEqual(result.extras.all, ["my-pkg", "numpy", "pandas"]);
    assert.deepEqual(result.extras.a, ["numpy"]);
  });

  it("settles self-referencing extras declared in reverse order and in cycles (#743)", () => {
    const result = parse(
      [
        "[project]",
        'name = "p"',
        "[project.optional-dependencies]",
        'all = ["p[b]"]',
        'b = ["p[a]", "x"]',
        'a = ["numpy", "p[b]"]',
      ].join("\n"),
    );
    assert.deepEqual([...(result.extras.all ?? [])].sort(), ["numpy", "p", "x"]);
    assert.deepEqual([...(result.extras.b ?? [])].sort(), ["numpy", "p", "x"]);
  });

  it("expands a ring of hundreds of self-referencing extras in linear time (#743)", () => {
    const size = 400;
    const lines = ["[project]", 'name = "p"', "[project.optional-dependencies]"];
    for (let i = 0; i < size; i++) lines.push(`e${i} = ["p[e${(i + 1) % size}]", "m${i}"]`);
    const started = Date.now();
    const result = parse(lines.join("\n"));
    assert.ok(Date.now() - started < 2000, "ring expansion stays fast");
    assert.equal(result.extras.e0?.length, size + 1);
    assert.ok(result.extras.e0?.includes(`m${size - 1}`));
  });

  it("expands tens of thousands of repeated self-references on one extra quickly (#743)", () => {
    const refs = Array.from({ length: 40000 }, () => '"p[b]"').join(", ");
    const text = [
      "[project]",
      'name = "p"',
      "[project.optional-dependencies]",
      `all = [${refs}]`,
      'b = ["x"]',
    ].join("\n");
    const started = Date.now();
    const result = parse(text);
    assert.ok(Date.now() - started < 3000, "repeated self-references stay fast");
    assert.deepEqual([...(result.extras.all ?? [])].sort(), ["p", "x"]);
  });

  it("keeps markers and records direct references", () => {
    const result = parse(`[project]
dependencies = ['tomli>=2; python_version < "3.11"', "lib @ git+https://example.com/lib.git"]
`);
    assert.equal(result.requirements[0]?.marker, 'python_version < "3.11"');
    assert.deepEqual(result.requirements[1]?.dependency.specifier, {
      type: "git",
      detail: "git+https://example.com/lib.git",
    });
  });

  it("notes dynamic dependencies it cannot read", () => {
    const result = parse(`[project]\nname = "x"\ndynamic = ["dependencies"]\n`);
    assert.ok(result.evidence.some((e) => e.kind === "dynamic-dependencies"));
  });

  it("reports unparsable requirement strings", () => {
    const result = parse(`[project]\ndependencies = ["not a requirement!"]\n`);
    assert.equal(result.requirements.length, 0);
    assert.ok(result.evidence.some((e) => e.kind === "requirement-unparsed"));
  });

  it("degrades on malformed TOML", () => {
    const result = parse(`[project\ndependencies = [`);
    assert.equal(result.malformed, true);
    assert.deepEqual(result.requirements, []);
    assert.equal(result.evidence[0]?.kind, "manifest-malformed");
  });

  it("states the TOML error line in manifest-malformed evidence (#269)", () => {
    const result = parse(`[project]\nname = "x"\ndependencies = [\n`);
    const e = result.evidence[0];
    assert.equal(e?.kind, "manifest-malformed");
    assert.equal(typeof e?.line, "number");
    assert.match(e?.statement ?? "", new RegExp(`:${e?.line}: invalid TOML`));
  });
});

describe("parsePyprojectText: one entry per name and kind (#235 review)", () => {
  it("merges a package listed in several extras into one Dependency", () => {
    const text = `
[project]
dependencies = ["requests>=2"]
[project.optional-dependencies]
socks = ["requests[socks]"]
all = ["requests", "rich"]
[build-system]
requires = ["hatchling"]
[tool.poetry.group.main.dependencies]
httpx = "^0.27"
`;
    assert.deepEqual(summary(text), [
      { name: "requests", kind: "runtime", constraint: ">=2" },
      {
        name: "requests",
        kind: "optional",
        constraint: "*",
        groups: ["socks", "all"],
        extras: ["socks"],
      },
      { name: "rich", kind: "optional", constraint: "*", groups: ["all"] },
      { name: "hatchling", kind: "build", constraint: "*" },
      { name: "httpx", kind: "runtime", constraint: "^0.27" },
    ]);
  });

  it("OR-s the markers of two conditional declarations", () => {
    const result = parse(`[project.optional-dependencies]
a = ['tomli; python_version < "3.11"']
b = ['tomli; sys_platform == "win32"']
`);
    assert.equal(
      result.requirements[0]?.marker,
      '(python_version < "3.11") or (sys_platform == "win32")',
    );
  });

  it("drops the marker when any declaration is unconditional", () => {
    const result = parse(`[project.optional-dependencies]
a = ['tomli; python_version < "3.11"']
b = ["tomli>=2"]
`);
    assert.equal(result.requirements.length, 1);
    assert.equal(result.requirements[0]?.marker, undefined);
    assert.equal(result.requirements[0]?.dependency.constraint, ">=2");
  });
});

describe("parsePyprojectText: Poetry (issue #43)", () => {
  it("treats group.main as runtime, including optional entries", () => {
    assert.deepEqual(
      summary(`[tool.poetry.group.main.dependencies]
httpx = "^0.27"
psycopg = { version = "^3", optional = true }
`),
      [
        { name: "httpx", kind: "runtime", constraint: "^0.27" },
        { name: "psycopg", kind: "optional", constraint: "^3" },
      ],
    );
  });

  it("reads dependencies, groups, legacy dev deps and extras", () => {
    const text = `
[tool.poetry.dependencies]
python = "^3.11"
requests = { version = "^2.31", extras = ["socks"] }
psycopg = { version = "^3.1", optional = true }
mylib = { git = "https://example.com/mylib.git", branch = "main" }
local = { path = "../local", develop = true }
numpy = [
  { version = "<2", python = "<3.9" },
  { version = ">=2", python = ">=3.9" },
]

[tool.poetry.extras]
postgres = ["psycopg"]

[tool.poetry.dev-dependencies]
black = "^24"

[tool.poetry.group.test.dependencies]
pytest = "^8"
`;
    assert.deepEqual(summary(text), [
      { name: "requests", kind: "runtime", constraint: "^2.31", extras: ["socks"] },
      { name: "psycopg", kind: "optional", constraint: "^3.1", groups: ["postgres"] },
      { name: "mylib", kind: "runtime", constraint: "https://example.com/mylib.git" },
      { name: "local", kind: "runtime", constraint: "../local" },
      { name: "numpy", kind: "runtime", constraint: "<2 || >=2" },
      { name: "black", kind: "dev", constraint: "^24", groups: ["dev"] },
      { name: "pytest", kind: "dev", constraint: "^8", groups: ["test"] },
    ]);
    const result = parse(text);
    assert.deepEqual(result.extras, { postgres: ["psycopg"] });
    const byName = new Map(result.requirements.map((r) => [r.dependency.name, r.dependency]));
    assert.equal(byName.get("mylib")?.specifier?.type, "git");
    assert.equal(byName.get("local")?.specifier?.type, "file");
  });

  it("merges Poetry 2 [project] tables with [tool.poetry] groups", () => {
    const text = `
[project]
dependencies = ["httpx"]

[tool.poetry.group.dev.dependencies]
ruff = "*"
`;
    assert.deepEqual(summary(text), [
      { name: "httpx", kind: "runtime", constraint: "*" },
      { name: "ruff", kind: "dev", constraint: "*", groups: ["dev"] },
    ]);
  });
});

describe("Poetry multiple constraints optionality (#544)", () => {
  for (const optional of [true, false]) {
    it(`requires every alternative to be optional (first optional=${optional})`, () => {
      const text = `[tool.poetry]
name = "demo"
[tool.poetry.dependencies]
python = "^3.10"
mixed = [{ version = "^1.0", optional = ${optional} }, { version = "^2.0", optional = ${!optional} }]
implicit = [{ version = "^1.0", optional = true }, { version = "^2.0" }]
all-optional = [{ version = "^3.0", optional = true }, { version = "^4.0", optional = true }]
[tool.poetry.group.dev.dependencies]
dev-mixed = [{ version = "^1", optional = true }, { version = "^2" }]
`;
      assert.deepEqual(summary(text), [
        { name: "mixed", kind: "runtime", constraint: "^1.0 || ^2.0" },
        { name: "implicit", kind: "runtime", constraint: "^1.0 || ^2.0" },
        { name: "all-optional", kind: "optional", constraint: "^3.0 || ^4.0" },
        { name: "dev-mixed", kind: "dev", constraint: "^1 || ^2", groups: ["dev"] },
      ]);
    });
  }
});

it("makes a Poetry alternative union unconditional when any arm has no marker", () => {
  for (const arms of [
    `{ version = "<2", markers = "sys_platform == 'win32'" }, { version = ">=2" }`,
    `{ version = ">=2" }, { version = "<2", markers = "sys_platform == 'win32'" }`,
  ]) {
    const result = parse(`[tool.poetry.dependencies]\nlib = [${arms}]\n`);
    assert.equal(result.requirements.length, 1);
    assert.equal(result.requirements[0]?.marker, undefined);
  }
  const conditional = parse(`[tool.poetry.dependencies]
lib = [
  { version = "<2", markers = "sys_platform == 'win32' and python_version < '3.11'" },
  { version = ">=2", markers = "sys_platform == 'linux'" },
]
`);
  assert.equal(
    conditional.requirements[0]?.marker,
    "(sys_platform == 'win32' and python_version < '3.11') or (sys_platform == 'linux')",
  );
});

it("keeps every Poetry extra that declares one optional dependency", () => {
  for (const section of ["tool.poetry.dependencies", "tool.poetry.group.main.dependencies"]) {
    const result = parsePyprojectText(
      `[${section}]\nrequests = {version="^2", optional=true}\n[tool.poetry.extras]\nweb=["requests"]\nhttp=["requests", "requests"]\n`,
      project,
      "pyproject.toml",
    );
    assert.equal(result.requirements.length, 1);
    assert.equal(result.requirements[0]?.dependency.kind, "optional");
    assert.deepEqual(result.requirements[0]?.groups, ["web", "http"], section);
    assert.deepEqual(result.extras, { web: ["requests"], http: ["requests"] });
  }
});

it("keeps source metadata when a bare PEP 621 declaration is upgraded", () => {
  for (const url of [
    "git+https://example.com/pkg.git",
    "file:../pkg",
    "https://example.com/pkg.whl",
  ]) {
    const result = parse(`[project]\ndependencies=["pkg", "pkg @ ${url}"]\n`);
    assert.equal(result.requirements.length, 1);
    const dep = result.requirements[0]!.dependency;
    assert.equal(dep.constraint, url);
    assert.deepEqual(dep.specifier, {
      type: url.startsWith("git+") ? "git" : url.startsWith("file:") ? "file" : "registry",
      detail: url,
    });
  }
});

it("does not replace an already constrained PEP 621 declaration with a later source", () => {
  const result = parse(
    '[project]\ndependencies=["pkg>=2", "pkg @ git+https://example.com/pkg.git"]\n',
  );
  assert.equal(result.requirements[0]?.dependency.constraint, ">=2");
  assert.equal(result.requirements[0]?.dependency.specifier, undefined);
});
