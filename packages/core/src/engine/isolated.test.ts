/**
 * Worker-thread adapter isolation (#90): the busy-loop adapter is
 * terminated at the stage budget and reported as an info finding, the
 * memory-hungry adapter dies on its heap ceiling without crashing the run,
 * and a well-behaved adapter produces the same result as in-process.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { analyseRepository, assembleAnalysisResult } from "./analyse.js";
import { analyseRepositoryIsolated, capOutcome, OUTCOME_CAPS } from "./isolated.js";
import type { AdapterOutcome } from "./run-adapter.js";
import { findingGroup, type ProjectRef } from "../types/index.js";
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

  it("salvages settled usage facts but never absence verdicts after usage timeout (#331)", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("partial-usage.mjs")],
        adapterTimeoutMs: 1_000,
        usageTimeoutMs: 250,
        usageConcurrency: 1,
        recommend: ({ dependencies, usageAnalysedEcosystems, referenceAnalysedEcosystems }) => {
          assert.equal(usageAnalysedEcosystems.has("partial-fixture"), false);
          assert.equal(referenceAnalysedEcosystems.has("partial-fixture"), false);
          return dependencies.map((dep) => ({
            kind: "unused" as const,
            dependency: dep.name,
            summary: `${dep.name} absent`,
            recommendation: "Remove it.",
            evidence: [{ kind: "no-import-found", statement: "no imports" }],
            confidence: "high" as const,
            limitations: [],
            affectedFiles: [dep.declaredIn],
          }));
        },
      });
      assert.deepEqual(
        result.usages.map((u) => u.dependency),
        ["used"],
      );
      assert.equal(result.dependencies.length, 2);
      assert.ok(
        result.findings.some(
          (f) => f.summary.includes("usage analysis timed out") && findingGroup(f) === "incomplete",
        ),
      );
      assert.equal(
        result.findings.some((f) => f.kind === "unused"),
        false,
      );
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
          f.summary.includes("detection timed out"),
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

  it("maxParallelAdapters serialises workers, bounding total heap (#125)", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const started = Date.now();
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("busy-loop.mjs"), fixture("busy-loop.mjs")],
        adapterTimeoutMs: 400,
        maxParallelAdapters: 1,
      });
      const elapsed = Date.now() - started;
      // Two busy loops run one after another (~1.4s each with grace), not
      // side by side; parallel would finish in roughly one budget.
      assert.ok(elapsed > 2_400, `workers overlapped: ${elapsed}ms`);
      assert.equal(result.findings.filter((f) => f.summary.includes("timed out")).length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a non-numeric maxParallelAdapters falls back to the default instead of zero lanes", async () => {
    const { dir, handle } = await fixtureRepo();
    try {
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [fixture("good.mjs")],
        adapterTimeoutMs: 30_000,
        maxParallelAdapters: Number.NaN,
      });
      // Zero lanes would leave the outcome undefined and no facts at all.
      assert.equal(result.detected.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a specifier resolving inside the analysed repository is rejected before a worker starts (#150)", async () => {
    const { dir, handle } = await fixtureRepo();
    const outside = await mkdtemp(join(tmpdir(), "ghostdeps-outside-"));
    try {
      // An adapter module inside the analysed tree: repository content must
      // never choose what code the engine loads. The symlink case points at
      // it from OUTSIDE the root - a lexical prefix check would miss it.
      await writeFile(join(dir, "evil-adapter.mjs"), "export default {};");
      const link = join(outside, "linked-adapter.mjs");
      await symlink(join(dir, "evil-adapter.mjs"), link);
      const rejected = [
        pathToFileURL(join(dir, "evil-adapter.mjs")).href,
        pathToFileURL(link).href,
        join(dir, "evil-adapter.mjs"), // absolute path form
        join(dir, "does-not-exist-yet.mjs"), // non-existent, still inside
        "./relative-adapter.mjs", // relative: rejected outright
      ];
      const result = await analyseRepositoryIsolated(handle, {
        adapters: [...rejected, fixture("good.mjs")],
        adapterTimeoutMs: 30_000,
      });
      const findings = result.findings.filter((f) =>
        f.summary.includes("must be trusted configuration"),
      );
      assert.equal(
        findings.length,
        rejected.length,
        `expected ${rejected.length} specifier-rejection findings, got ${JSON.stringify(result.findings.map((f) => f.summary))}`,
      );
      // The trusted adapter still ran.
      assert.equal(result.detected.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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

describe("capOutcome (#123 review)", () => {
  const project: ProjectRef = { path: ".", ecosystem: "x", packageManagers: [] };
  const baseOutcome = (): AdapterOutcome => ({
    ecosystem: "x",
    dependencies: [],
    usages: [],
    graphs: [],
    usageAnalysed: true,
    findings: [],
  });

  it("keeps referenceAnalysed only when it is exactly true", () => {
    const posted = { ...baseOutcome(), referenceAnalysed: "yes" } as unknown as AdapterOutcome;
    assert.equal(capOutcome(posted).referenceAnalysed, false);
    assert.equal(capOutcome({ ...baseOutcome(), referenceAnalysed: true }).referenceAnalysed, true);
  });

  it("marks usage analysis incomplete when usages are capped", () => {
    const outcome = baseOutcome();
    outcome.referenceAnalysed = true;
    outcome.dependencies = [
      { name: "late-dep", constraint: "^1.0.0", kind: "runtime", project, declaredIn: "m" },
    ];
    for (let i = 0; i < OUTCOME_CAPS.maxUsages; i++) {
      outcome.usages.push({
        dependency: `dep-${i}`,
        file: "a.ts",
        line: 1,
        form: "static",
        symbols: [],
      });
    }
    // late-dep's only usage sits past the cap.
    outcome.usages.push({
      dependency: "late-dep",
      file: "b.ts",
      line: 1,
      form: "static",
      symbols: [],
    });
    const capped = capOutcome(outcome);
    assert.equal(capped.usages.length, OUTCOME_CAPS.maxUsages);
    assert.equal(
      capped.usageAnalysed,
      false,
      "a capped usage list must not read as a complete usage analysis",
    );
    assert.equal(capped.referenceAnalysed, false);
  });

  it("a dependency whose only usage is past the cap gets no unused finding", async () => {
    const outcome = baseOutcome();
    outcome.dependencies = [
      { name: "late-dep", constraint: "^1.0.0", kind: "runtime", project, declaredIn: "m" },
    ];
    for (let i = 0; i < OUTCOME_CAPS.maxUsages; i++) {
      outcome.usages.push({
        dependency: `dep-${i}`,
        file: "a.ts",
        line: 1,
        form: "static",
        symbols: [],
      });
    }
    outcome.usages.push({
      dependency: "late-dep",
      file: "b.ts",
      line: 1,
      form: "static",
      symbols: [],
    });
    const capped = capOutcome(outcome);
    const result = await assembleAnalysisResult(
      [capped],
      ({ dependencies, usages, usageAnalysedEcosystems }) =>
        dependencies
          .filter((d) => usageAnalysedEcosystems.has(d.project.ecosystem))
          .filter((d) => !usages.some((u) => u.dependency === d.name))
          .map((d) => ({
            kind: "unused" as const,
            dependency: d.name,
            summary: `${d.name} is never imported`,
            recommendation: "Remove it.",
            evidence: [{ kind: "no-import-found", statement: "no imports" }],
            confidence: "high" as const,
            limitations: [],
            affectedFiles: [d.declaredIn],
          })),
    );
    assert.equal(
      result.findings.some((f) => f.kind === "unused" && f.dependency === "late-dep"),
      false,
      "capped usage analysis must not produce a false unused finding",
    );
  });

  it("counts closure entries against the graph budget and drops oversized graphs whole", () => {
    const outcome = baseOutcome();
    const small = {
      project,
      nodes: [{ name: "a", version: "1.0.0", dependencies: [], dev: false }],
      transitiveClosure: { a: [] },
      incomplete: false,
    };
    // Few nodes, huge closure: the reviewer's unbounded case.
    const fat = {
      project,
      nodes: [{ name: "b", version: "1.0.0", dependencies: [], dev: false }],
      transitiveClosure: {
        b: Array.from({ length: OUTCOME_CAPS.maxGraphNodes }, (_, i) => `n-${i}`),
      },
      incomplete: false,
    };
    outcome.graphs = [small, fat];
    const capped = capOutcome(outcome);
    assert.deepEqual(capped.graphs, [small]);
    const limitation = capped.findings
      .flatMap((f) => f.limitations)
      .find((l) => l.includes("Dropped 1 graph"));
    assert.ok(
      limitation,
      `expected a dropped-graph limitation, got ${JSON.stringify(capped.findings)}`,
    );
    // The kept graph is untouched - no truncated nodes or pruned closure.
    assert.equal(capped.graphs[0], small);
  });

  it("caps the findings count", () => {
    const outcome = baseOutcome();
    for (let i = 0; i < OUTCOME_CAPS.maxFindings + 5; i++) {
      outcome.findings.push({
        kind: "info",
        summary: `f-${i}`,
        recommendation: "r",
        evidence: [],
        confidence: "low",
        limitations: [],
        affectedFiles: [],
      });
    }
    const capped = capOutcome(outcome);
    assert.equal(
      capped.findings.length,
      OUTCOME_CAPS.maxFindings + 1,
      "capped findings plus the truncation finding",
    );
    assert.ok(capped.findings.some((f) => f.summary.includes("truncated to size ceilings")));
  });

  describe("notes stage failures keep the analysis (#205)", () => {
    for (const [name, heap, timeout] of [
      ["notes-hang.mjs", undefined, 500],
      ["notes-busy.mjs", undefined, 500],
      ["notes-hog.mjs", 64, 10_000],
    ] as const) {
      it(`${name}: dependencies survive, one incomplete notes finding`, async () => {
        const { dir, handle } = await fixtureRepo();
        try {
          const result = await analyseRepositoryIsolated(handle, {
            adapters: [fixture(name)],
            adapterTimeoutMs: timeout,
            ...(heap ? { adapterHeapMb: heap } : {}),
          });
          assert.deepEqual(
            result.dependencies.map((d) => d.name),
            ["left-pad"],
            JSON.stringify(result.findings),
          );
          const failures = result.findings.filter((f) =>
            f.evidence.some((e) => e.kind === "adapter-error"),
          );
          assert.equal(failures.length, 1, JSON.stringify(result.findings));
          assert.match(failures[0]!.summary, /notes/);
          assert.equal(findingGroup(failures[0]!), "incomplete");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }

    it("notes-ok.mjs: notes cross the worker boundary", async () => {
      const { dir, handle } = await fixtureRepo();
      try {
        const result = await analyseRepositoryIsolated(handle, {
          adapters: [fixture("notes-ok.mjs")],
        });
        assert.deepEqual(result.findings.map((f) => [f.rule, findingGroup(f)]).sort(), [
          ["adapter-capability", "awareness"],
          ["adapter-note", "note"],
        ]);
        assert.equal(result.dependencies[0]?.name, "left-pad");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
