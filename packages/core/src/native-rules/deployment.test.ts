import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import { collectNativeDeploymentEvidence, NATIVE_TARGETS_FILE } from "./deployment.js";
import type { RepositoryHandle } from "../types/index.js";

const digest = "a".repeat(64);
const file = (content?: string, otherFiles: readonly string[] = []): RepositoryHandle => ({
  listFiles: async () => [...otherFiles, ...(content === undefined ? [] : [NATIVE_TARGETS_FILE])],
  exists: async (path) => path === NATIVE_TARGETS_FILE && content !== undefined,
  readFile: async (path) => {
    if (path !== NATIVE_TARGETS_FILE || content === undefined) throw new Error("unavailable");
    return content;
  },
});
const declaration = (entries: unknown[], complete: unknown = true) =>
  JSON.stringify({ schemaVersion: 1, complete, targets: entries }, null, 2);
const node = (minVersion: string) => ({ id: "production", runtime: "node", minVersion });
const run = (content?: string, otherFiles: readonly string[] = []) =>
  collectNativeDeploymentEvidence(file(content, otherFiles), AXIOS_FETCH_RULE, digest);

describe("native deployment target gate (#438)", () => {
  it("reads an exhaustive single-target declaration with exact source-byte provenance", async () => {
    const raw = declaration([node(">=22.0")]);
    const result = await run(raw);
    assert.equal(result.status, "pass");
    assert.equal(result.binding, "caller-asserted");
    assert.deepEqual(result.blocking, []);
    assert.equal(result.targets.length, 1);
    const target = result.targets[0]!;
    assert.equal(target.runtime, "node");
    assert.equal(target.minimumVersion, "22.0.0");
    assert.equal(target.declaration?.file, NATIVE_TARGETS_FILE);
    assert.equal(target.declaration?.snapshotSha256, digest);
    assert.equal(target.declaration?.line, 5);
    assert.equal(target.authority, "deployment");
    assert.equal(target.binding, "caller-asserted");
    assert.deepEqual(JSON.parse(target.declarationText!), node(">=22.0"));
    assert.ok(raw.includes(target.declarationText!));
    assert.deepEqual(target.declaration?.span, {
      sha256: createHash("sha256").update(target.declarationText!).digest("hex"),
    });
  });

  it("does not infer a target from CI matrices or engines when the inventory is absent", async () => {
    const ci = await run(undefined, ["package.json", ".github/workflows/ci.yml"]);
    assert.equal(ci.status, "blocked");
    assert.equal(ci.blocking[0]?.reason, "declaration-unavailable");
  });

  it("rejects incomplete inventories even with an engine and CI matrix", async () => {
    const result = await run(declaration([node("22.0.0")], false), [
      "package.json",
      ".github/workflows/ci.yml",
    ]);
    assert.equal(result.status, "blocked");
    assert.equal(result.blocking[0]?.reason, "incomplete-inventory");
  });

  it("rejects ambiguous and below-floor versions with source-backed reasons", async () => {
    for (const [floor, reason] of [
      ["^22.0.0", "ambiguous-range"],
      ["18.0.0", "below-floor"],
    ] as const) {
      const result = await run(declaration([node(floor)]));
      assert.equal(result.status, "blocked");
      assert.equal(result.blocking[0]?.reason, reason);
      assert.equal(result.blocking[0]?.binding, "caller-asserted");
      assert.equal(result.blocking[0]?.source?.file, NATIVE_TARGETS_FILE);
      assert.equal(result.blocking[0]?.source?.snapshotSha256, digest);
    }
  });

  it("rejects unsupported browser and edge targets, even with a qualifying Node target", async () => {
    for (const runtime of ["browser", "edge"]) {
      const result = await run(
        declaration([node("22.0.0"), { id: runtime, runtime, minVersion: "120.0.0" }]),
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.targets.length, 2);
      assert.equal(result.blocking[0]?.reason, "unsupported-target");
    }
  });

  it("blocks malformed, duplicate, unreadable, oversized and invalid snapshot input", async () => {
    for (const raw of [
      "{",
      declaration([]),
      declaration([node("22.0.0"), node("22.0.0")]),
      '{"schemaVersion":1,"complete":true,"targets":[{"id":"production","runtime":"node","minVersion":"22.0.0","minVersion":"18.0.0"}]}',
      '{"schemaVersion":1,"complete":true,"targets":[{"id":"production","runtime":"node","minVersion":"22.0.0"}],"complete":false}',
      "x".repeat(64 * 1024 + 1),
    ]) {
      assert.equal((await run(raw)).status, "blocked");
    }
    assert.equal(
      (
        await collectNativeDeploymentEvidence(
          file(declaration([node("22.0.0")])),
          AXIOS_FETCH_RULE,
          "not-a-digest",
        )
      ).blocking[0]?.reason,
      "snapshot-unavailable",
    );
  });
});
