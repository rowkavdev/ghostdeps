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
    ...(r.group !== undefined ? { group: r.group } : {}),
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
      { name: "typer", kind: "optional", constraint: ">=0.12", group: "cli", extras: ["all"] },
      { name: "pytest", kind: "dev", constraint: ">=8", group: "test" },
      { name: "ruff", kind: "dev", constraint: "*", group: "lint" },
      { name: "hatchling", kind: "build", constraint: "*" },
      { name: "mypy", kind: "dev", constraint: "*" },
    ]);
    assert.deepEqual(parse(text).extras, { cli: ["typer"] });
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
});

describe("parsePyprojectText: Poetry (issue #43)", () => {
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
      { name: "psycopg", kind: "optional", constraint: "^3.1", group: "postgres" },
      { name: "mylib", kind: "runtime", constraint: "https://example.com/mylib.git" },
      { name: "local", kind: "runtime", constraint: "../local" },
      { name: "numpy", kind: "runtime", constraint: "<2 || >=2" },
      { name: "black", kind: "dev", constraint: "^24", group: "dev" },
      { name: "pytest", kind: "dev", constraint: "^8", group: "test" },
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
      { name: "ruff", kind: "dev", constraint: "*", group: "dev" },
    ]);
  });
});
