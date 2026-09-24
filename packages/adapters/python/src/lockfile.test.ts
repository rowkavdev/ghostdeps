import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, ProjectRef } from "@ghostdeps/core";
import { detectPython } from "./detect.js";
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

  it("scopes each workspace member to what its own dependencies reach", async () => {
    const lock = `version = 1

[manifest]
members = ["api", "core", "worker"]

[[package]]
name = "api"
version = "0.1.0"
source = { editable = "packages/api" }
dependencies = [{ name = "click" }, { name = "core" }]

[[package]]
name = "click"
version = "8.1.7"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "colorama" }]

[[package]]
name = "colorama"
version = "0.4.6"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "core"
version = "0.1.0"
source = { editable = "packages/core" }
dependencies = [{ name = "attrs" }]

[[package]]
name = "attrs"
version = "24.2.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "worker"
version = "0.1.0"
source = { editable = "packages/worker" }
dependencies = [{ name = "celery" }]

[[package]]
name = "celery"
version = "5.4.0"
source = { registry = "https://pypi.org/simple" }
`;
    const files = {
      "packages/api/pyproject.toml": '[project]\nname = "api"\ndependencies = ["click", "core"]\n',
      "packages/core/pyproject.toml": '[project]\nname = "core"\ndependencies = ["attrs"]\n',
      "packages/worker/pyproject.toml": '[project]\nname = "worker"\n',
      "uv.lock": lock,
    };
    const at = (path: string): ProjectRef => ({ path, ecosystem: "python", packageManagers: [] });
    const api = (await buildProjectGraph(ctx(files), at("packages/api"))).graph;
    // core's own dependency is reached through it; core itself is first-party.
    assert.deepEqual(api.nodes.map((n) => n.name).sort(), ["attrs", "click", "colorama"]);
    assert.ok(api.nodes.every((n) => !n.dev));
    assert.deepEqual(api.transitiveClosure, { click: ["colorama"], core: ["attrs"] });
    assert.equal(api.incomplete, false);

    const core = (await buildProjectGraph(ctx(files), at("packages/core"))).graph;
    assert.deepEqual(
      core.nodes.map((n) => n.name),
      ["attrs"],
    );
    assert.deepEqual(core.transitiveClosure, { attrs: [] });

    // A member that declares nothing gets an empty graph, not the whole lock.
    const worker = (await buildProjectGraph(ctx(files), at("packages/worker"))).graph;
    assert.deepEqual(worker.nodes, []);
    assert.deepEqual(worker.transitiveClosure, {});
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

describe("lockfile evidence in detection (#45 review)", () => {
  it("explains an incomplete graph through detection evidence", async () => {
    const result = await detectPython(
      ctx({ "pyproject.toml": PYPROJECT, "uv.lock": "[[package]\n", "app/__init__.py": "" }),
    );
    assert.ok(result.projects.length > 0);
    assert.ok(result.evidence.some((e) => e.kind === "lockfile-malformed"));
  });

  it("names stale declared dependencies", async () => {
    const { evidence } = await buildProjectGraph(
      ctx({
        "pyproject.toml": PYPROJECT.replace('"httpx>=0.27"', '"httpx>=0.27", "rich"'),
        "uv.lock": UV_LOCK,
      }),
      project,
    );
    assert.match(evidence.find((e) => e.kind === "lockfile-mismatch")?.statement ?? "", /\(rich\)/);
  });
});
