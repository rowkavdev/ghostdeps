/**
 * Worker-thread adapter isolation (#90): the busy-loop adapter is
 * terminated at the stage budget and reported as an info finding, the
 * memory-hungry adapter dies on its heap ceiling without crashing the run,
 * and a well-behaved adapter produces the same result as in-process.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyseRepository } from "./analyse.js";
import { analyseRepositoryIsolated } from "./isolated.js";
import { FsRepositoryHandle } from "./scanner/handle.js";

const fixture = (name: string): string =>
  new URL(`../../test/isolated-adapters/${name}`, import.meta.url).href;

async function fixtureRepo(): Promise<{ dir: string; handle: FsRepositoryHandle }> {
  const dir = await mkdtemp(join(tmpdir(), "ghostdeps-isolated-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  return { dir, handle: await FsRepositoryHandle.open(dir) };
}

describe("worker-thread adapter isolation (#90)", () => {
  it("a well-behaved adapter produces the same facts as in-process", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const specifier = fixture("good.mjs");
      const isolated = await analyseRepositoryIsolated(handle, {
        adapters: [specifier],
        adapterTimeoutMs: 10_000,
      });
      const { default: adapter } = (await import(specifier)) as {
        default: Parameters<typeof analyseRepository>[1]["adapters"][number];
      };
      const inProcess = await analyseRepository(handle, { adapters: [adapter] });
      assert.deepEqual(isolated, inProcess);
      assert.equal(isolated.detected[0]?.ecosystem, "fixture");
      assert.equal(isolated.dependencies[0]?.name, "left-pad");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("terminates a synchronous busy-loop adapter at the stage budget and reports it", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const started = Date.now();
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("busy-loop.mjs")],
        adapterTimeoutMs: 500,
      });
      const elapsed = Date.now() - started;
      // The worker is killed just past the budget; the run never hangs.
      assert.ok(elapsed < 10_000, `run took ${elapsed}ms - the busy loop escaped`);
      const finding = result.findings.find(
        (f) =>
          f.kind === "info" &&
          f.summary.includes("busy-loop") &&
          f.summary.includes("timed out during detection"),
      );
      assert.ok(
        finding,
        `expected a busy-loop timeout finding, got ${JSON.stringify(result.findings)}`,
      );
      assert.equal(finding.confidence, "low");
      assert.ok(finding.limitations.some((l) => l.includes("busy-loop")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a memory-hungry adapter dies on its heap ceiling without crashing the run", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("memory-hog.mjs"), fixture("good.mjs")],
        adapterTimeoutMs: 10_000,
        adapterHeapMb: 64,
      });
      const finding = result.findings.find(
        (f) => f.kind === "info" && f.summary.includes("memory-hog"),
      );
      assert.ok(
        finding,
        `expected a memory-hog failure finding, got ${JSON.stringify(result.findings)}`,
      );
      // The run survived and the healthy adapter's facts are intact.
      assert.equal(result.detected[0]?.ecosystem, "fixture");
      assert.equal(result.dependencies[0]?.name, "left-pad");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adapter stdout/stderr is captured to debugLog, never inherited by the parent", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const lines: string[] = [];
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("chatty.mjs")],
        adapterTimeoutMs: 10_000,
        debugLog: (line) => lines.push(line),
      });
      assert.equal(result.detected[0]?.ecosystem, "chatty");
      assert.ok(
        lines.some((line) => line === "chatty stdout: chatty detection log line"),
        `stdout line missing from debugLog: ${JSON.stringify(lines)}`,
      );
      assert.ok(
        lines.some((line) => line === "chatty stderr: chatty detection error line"),
        `stderr line missing from debugLog: ${JSON.stringify(lines)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discards adapter output without a debugLog and still completes", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("chatty.mjs")],
        adapterTimeoutMs: 10_000,
      });
      assert.equal(result.detected[0]?.ecosystem, "chatty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps an oversized worker-posted outcome and reports the truncation", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("over-poster.mjs")],
        adapterTimeoutMs: 30_000,
      });
      // 12,000 posted, capped at 10,000 main-side (#123).
      assert.equal(result.dependencies.length, 10_000);
      const finding = result.findings.find(
        (f) => f.kind === "info" && f.summary.includes("truncated to size ceilings"),
      );
      assert.ok(
        finding,
        `expected a truncation finding, got ${JSON.stringify(result.findings.map((f) => f.summary))}`,
      );
      assert.ok(finding.limitations.some((l) => l.includes("12") && l.includes("dependencies")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a module without an adapter export becomes an info finding, not a crash", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("not-an-adapter.mjs")],
        adapterTimeoutMs: 5_000,
      });
      const finding = result.findings.find(
        (f) => f.kind === "info" && f.summary.includes("does not export an EcosystemAdapter"),
      );
      assert.ok(
        finding,
        `expected a resolution failure finding, got ${JSON.stringify(result.findings)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
