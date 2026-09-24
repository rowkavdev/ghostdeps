import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAdapterContractTests } from "@ghostdeps/core";
import type { AdapterContext, RepositoryHandle } from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "./adapter.js";
import { DETECTION_CONFIDENCE_THRESHOLD, detectJavaScriptTypeScript } from "./detect.js";
import { fixtureHandle, memoryHandle } from "./testing/fs-handle.js";

function contextFor(repository: RepositoryHandle): AdapterContext {
  return { repository, network: { mode: "offline" } };
}

describe("js/ts ecosystem detection (issue #24)", () => {
  it("detects a real JS project above threshold and lists what was found", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(fixtureHandle("js", "basic-unused")),
    );
    assert.ok(result.confidence >= DETECTION_CONFIDENCE_THRESHOLD);
    assert.deepEqual(
      result.projects.map((project) => project.path),
      ["."],
    );
    assert.equal(result.projects[0]?.ecosystem, "javascript-typescript");
    assert.ok(result.evidence.some((entry) => entry.kind === "manifest-found"));
    assert.ok(result.evidence.some((entry) => entry.kind === "source-files"));
  });

  it("scores package.json-without-source below threshold and skips it with a reason", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(fixtureHandle("js", "package-json-without-js")),
    );
    assert.ok(result.confidence < DETECTION_CONFIDENCE_THRESHOLD);
    assert.equal(result.projects.length, 0);
    assert.ok(result.evidence.some((entry) => entry.kind === "no-js-ts-source"));
    const skipped = result.evidence.find((entry) => entry.kind === "project-skipped");
    assert.ok(skipped, "a below-threshold root must carry its skip reason as evidence");
    assert.match(skipped.statement, /below the detection threshold/);
  });

  it("returns zero confidence and no projects when no manifest exists", async () => {
    const result = await detectJavaScriptTypeScript(contextFor(memoryHandle({})));
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.projects, []);
    assert.deepEqual(result.evidence, []);
  });

  it("ignores vendored package.json copies and vendored source", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{}",
          "src/index.js": "export {};",
          "node_modules/left-pad/package.json": "{}",
          "node_modules/left-pad/index.js": "module.exports = 1;",
        }),
      ),
    );
    assert.deepEqual(
      result.projects.map((project) => project.path),
      ["."],
    );
    const sourceEvidence = result.evidence.find((entry) => entry.kind === "source-files");
    assert.match(sourceEvidence?.statement ?? "", /1 JS\/TS source file/);
  });

  it("assigns nested source to the nearest project root in a monorepo", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": '{ "workspaces": ["packages/*"] }',
          "packages/app/package.json": "{}",
          "packages/app/src/index.ts": "export {};",
        }),
      ),
    );
    // A declared workspace root with sourced members is a real project root
    // (its devDependencies matter); the member owns its own source.
    assert.deepEqual(
      result.projects.map((project) => project.path),
      [".", "packages/app"],
    );
    assert.ok(result.evidence.some((entry) => entry.kind === "workspace-root"));
  });

  it("still skips a manifest-only root that declares no workspace", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{}",
          "packages/app/package.json": "{}",
          "packages/app/src/index.ts": "export {};",
        }),
      ),
    );
    assert.deepEqual(
      result.projects.map((project) => project.path),
      ["packages/app"],
    );
    assert.ok(
      result.evidence.some(
        (entry) => entry.kind === "project-skipped" && entry.statement.includes("repository root"),
      ),
    );
  });

  it("does not treat declaration-only packages as meaningful source", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{}",
          "types/index.d.ts": "export declare const x: number;",
        }),
      ),
    );
    assert.ok(result.confidence < DETECTION_CONFIDENCE_THRESHOLD);
    assert.equal(result.projects.length, 0);
  });

  it("degrades confidence on a malformed manifest instead of crashing", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{ not json",
          "src/index.ts": "export {};",
        }),
      ),
    );
    assert.ok(result.evidence.some((entry) => entry.kind === "manifest-malformed"));
    // Source exists, so detection still passes at exactly threshold.
    assert.equal(result.confidence, DETECTION_CONFIDENCE_THRESHOLD);
  });

  it("scores tsconfig and lockfiles as supporting evidence", async () => {
    const plain = await detectJavaScriptTypeScript(
      contextFor(memoryHandle({ "package.json": "{}", "src/index.js": "export {};" })),
    );
    const supported = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{}",
          "src/index.js": "export {};",
          "tsconfig.json": "{}",
          "pnpm-lock.yaml": "lockfileVersion: '9.0'",
        }),
      ),
    );
    assert.ok(supported.confidence > plain.confidence);
    assert.ok(supported.evidence.some((entry) => entry.kind === "tsconfig-found"));
    assert.ok(supported.evidence.some((entry) => entry.kind === "lockfile-found"));
  });
});

// The shared contract suite (ADR 0002) must pass against our fixtures.
runAdapterContractTests(
  createJavaScriptTypeScriptAdapter(),
  contextFor(fixtureHandle("js", "basic-unused")),
);
