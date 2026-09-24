import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, ProjectRef } from "@ghostdeps/core";
import { buildProjectGraph, parsePoetryLock, parseUvLock } from "./lockfile.js";
import { memoryHandle } from "./testing/fs-handle.js";

const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
const ctx = (files: Record<string, string>): AdapterContext => ({
  repository: memoryHandle(files),
  network: { mode: "offline" },
});

const UV_LOCK = `version = 1
requires-python = ">=3.11"

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
dependencies = [{ name = "httpx" }]

[package.dev-dependencies]
dev = [{ name = "pytest" }]

[[package]]
name = "httpx"
version = "0.27.2"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "anyio" }, { name = "certifi" }]

[[package]]
name = "anyio"
version = "4.6.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "idna" }, { name = "sniffio" }]

[[package]]
name = "certifi"
version = "2024.8.30"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "idna"
version = "3.10"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "sniffio"
version = "1.3.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pytest"
version = "8.3.3"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "iniconfig" }]

[[package]]
name = "iniconfig"
version = "2.0.0"
source = { registry = "https://pypi.org/simple" }
`;

const PYPROJECT = `[project]
name = "app"
dependencies = ["httpx>=0.27"]

[dependency-groups]
dev = ["pytest>=8"]
`;

describe("parseUvLock (issue #45)", () => {
  it("separates the project entry from resolved packages", () => {
    const parsed = parseUvLock(UV_LOCK);
    assert.equal(parsed.root?.name, "app");
    assert.deepEqual(parsed.root?.dependencies, ["httpx", "pytest"]);
    assert.equal(parsed.packages.length, 7);
  });
});

describe("parsePoetryLock (issue #45)", () => {
  it("reads packages and dependency edges, dropping python", () => {
    const parsed = parsePoetryLock(`[[package]]
name = "Requests"
version = "2.32.3"
[package.dependencies]
certifi = ">=2017.4.17"
charset-normalizer = ">=2,<4"
python = ">=3.8"

[[package]]
name = "certifi"
version = "2024.8.30"
`);
    assert.deepEqual(parsed.packages[0], {
      name: "requests",
      version: "2.32.3",
      dependencies: ["certifi", "charset-normalizer"],
    });
  });
});

describe("buildProjectGraph (issue #45)", () => {
  it("computes transitive closure per direct dependency and dev reachability", async () => {
    const { graph } = await buildProjectGraph(
      ctx({ "pyproject.toml": PYPROJECT, "uv.lock": UV_LOCK }),
      project,
    );
    assert.equal(graph.incomplete, false);
    assert.deepEqual(graph.transitiveClosure, {
      httpx: ["anyio", "certifi", "idna", "sniffio"],
      pytest: ["iniconfig"],
    });
    const dev = new Map(graph.nodes.map((n) => [n.name, n.dev]));
    assert.equal(dev.get("anyio"), false);
    assert.equal(dev.get("iniconfig"), true);
  });

  it("resolves a uv workspace member through the root uv.lock", async () => {
    const member: ProjectRef = { path: "packages/api", ecosystem: "python", packageManagers: [] };
    const { graph, evidence } = await buildProjectGraph(
      ctx({
        "packages/api/pyproject.toml": '[project]\nname = "api"\ndependencies = ["httpx"]\n',
        "uv.lock": UV_LOCK,
      }),
      member,
    );
    assert.equal(graph.incomplete, false);
    assert.equal(graph.transitiveClosure.httpx?.length, 4);
    assert.ok(evidence.some((e) => e.kind === "lockfile-inherited"));
  });

  it("marks the graph incomplete without a lockfile", async () => {
    const { graph, evidence } = await buildProjectGraph(
      ctx({ "pyproject.toml": PYPROJECT }),
      project,
    );
    assert.equal(graph.incomplete, true);
    assert.deepEqual(graph.nodes, []);
    assert.equal(evidence[0]?.kind, "lockfile-missing");
  });

  it("degrades on a malformed lockfile", async () => {
    const { graph, evidence } = await buildProjectGraph(
      ctx({ "pyproject.toml": PYPROJECT, "uv.lock": "[[package]\n" }),
      project,
    );
    assert.equal(graph.incomplete, true);
    assert.equal(evidence[0]?.kind, "lockfile-malformed");
  });

  it("flags declared dependencies missing from the lockfile", async () => {
    const { graph, evidence } = await buildProjectGraph(
      ctx({
        "pyproject.toml": PYPROJECT.replace('"httpx>=0.27"', '"httpx>=0.27", "rich"'),
        "uv.lock": UV_LOCK,
      }),
      project,
    );
    assert.equal(graph.incomplete, true);
    assert.ok(evidence.some((e) => e.kind === "lockfile-mismatch"));
  });
});
