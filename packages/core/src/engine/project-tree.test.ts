import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRef } from "../types/index.js";
import { buildProjectTree, projectId } from "./project-tree.js";

const p = (ecosystem: string, path: string): ProjectRef => ({
  ecosystem,
  path,
  packageManagers: [],
});
const JS = "javascript-typescript";
const PY = "python";

describe("buildProjectTree (#55)", () => {
  it("builds deterministic ids", () => {
    assert.equal(projectId(p(JS, "packages/web")), "javascript-typescript:packages/web");
    assert.equal(projectId(p(JS, "./packages/web/")), "javascript-typescript:packages/web");
    assert.equal(projectId(p(JS, "")), "javascript-typescript:.");
  });

  it("parents each project to the nearest enclosing project, across ecosystems", () => {
    const tree = buildProjectTree([
      p(JS, "."),
      p(JS, "packages/web"),
      p(PY, "services/api"),
      p(PY, "services/api/worker"),
      p(JS, "packages/web/e2e"),
    ]);
    assert.deepEqual(tree, [
      { id: `${JS}:.`, path: ".", ecosystem: JS },
      { id: `${JS}:packages/web`, path: "packages/web", ecosystem: JS, parent: `${JS}:.` },
      {
        id: `${JS}:packages/web/e2e`,
        path: "packages/web/e2e",
        ecosystem: JS,
        parent: `${JS}:packages/web`,
      },
      { id: `${PY}:services/api`, path: "services/api", ecosystem: PY, parent: `${JS}:.` },
      {
        id: `${PY}:services/api/worker`,
        path: "services/api/worker",
        ecosystem: PY,
        parent: `${PY}:services/api`,
      },
    ]);
  });

  it("breaks ties at the enclosing path by lowest ecosystem name", () => {
    const tree = buildProjectTree([p(PY, "."), p("go", "."), p(JS, "."), p("rust", "tools/cli")]);
    assert.equal(tree.find((n) => n.path === "tools/cli")?.parent, "go:.");
  });

  it("never parents projects at the same path to each other", () => {
    const tree = buildProjectTree([p(JS, "app"), p(PY, "app")]);
    assert.ok(tree.every((n) => n.parent === undefined));
  });

  it("uses path components, not string prefixes", () => {
    const tree = buildProjectTree([p(JS, "app"), p(JS, "app-two"), p(JS, "app/x")]);
    assert.equal(tree.find((n) => n.path === "app-two")?.parent, undefined);
    assert.equal(tree.find((n) => n.path === "app/x")?.parent, `${JS}:app`);
  });

  it("is independent of input order and collapses duplicates", () => {
    const input = [p(JS, "."), p(PY, "a"), p(JS, "a/b"), p("go", "a"), p(JS, "a/b")];
    const expected = buildProjectTree(input);
    assert.equal(expected.length, 4);
    for (let i = 0; i < 10; i++) {
      const shuffled = [...input].sort(() => Math.random() - 0.5);
      assert.deepEqual(buildProjectTree(shuffled), expected);
    }
    assert.equal(expected.find((n) => n.path === "a/b")?.parent, "go:a");
  });

  it("scales linearly: 10,000 projects build quickly", () => {
    const many: ProjectRef[] = [p(JS, ".")];
    for (let i = 0; i < 100; i++) {
      many.push(p(JS, `pkgs/g${i}`));
      for (let j = 0; j < 99; j++) many.push(p(PY, `pkgs/g${i}/m${j}`));
    }
    const start = performance.now();
    const tree = buildProjectTree(many);
    const ms = performance.now() - start;
    assert.equal(tree.length, 10_001);
    assert.equal(tree.find((n) => n.path === "pkgs/g7/m3")?.parent, `${JS}:pkgs/g7`);
    // The quadratic version took seconds here; the ancestor walk takes milliseconds.
    assert.ok(ms < 1000, `took ${ms}ms`);
  });

  it("returns an empty tree for no projects", () => {
    assert.deepEqual(buildProjectTree([]), []);
  });
});
