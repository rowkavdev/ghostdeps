import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { createDefaultPolicy } from "../recommend/index.js";
import {
  findingGroup,
  type Dependency,
  type ProjectRef,
  type RepositoryHandle,
} from "../types/index.js";
import { adapterNoteFindings, MAX_ADAPTER_NOTE_CHARS, MAX_ADAPTER_NOTES } from "./adapter-notes.js";
import { analyseRepository, type RecommendationInput } from "./analyse.js";
import { capOutcome } from "./isolated.js";
import type { AdapterOutcome } from "./run-adapter.js";

const handle: RepositoryHandle = {
  async listFiles() {
    return ["package.json"];
  },
  async readFile() {
    return "{}";
  },
  async exists(p) {
    return p === "package.json";
  },
};
const project: ProjectRef = { path: ".", ecosystem: "mock", packageManagers: [] };
const dep = (name: string): Dependency => ({
  name,
  constraint: "^1.0.0",
  kind: "runtime",
  project,
  declaredIn: "package.json",
});

function adapter(notes: EcosystemAdapter["notes"]): EcosystemAdapter {
  const deps = [dep("left-pad"), dep("vite-plugin")];
  const a: EcosystemAdapter = {
    ecosystem: "mock",
    apiVersion: adapterApiVersion,
    capabilities: new Set(["usageAnalysis", "referenceAnalysis"]),
    async detect() {
      return { confidence: 0.9, projects: [project], evidence: [] };
    },
    async listDirectDependencies() {
      return deps;
    },
    async findUsage() {
      return { usages: [], referenceAnalysisComplete: true };
    },
  };
  if (notes) a.notes = notes;
  return a;
}

describe("adapter notes channel (#205)", () => {
  it("maps both shapes, never caps, and keeps reference analysis", async () => {
    let seen: RecommendationInput | undefined;
    const result = await analyseRepository(handle, {
      adapters: [
        adapter(async () => [
          { statement: "credited by a string in vite.config.ts", dependency: "vite-plugin" },
          { statement: "graph edges unavailable" },
        ]),
      ],
      recommend: (input) => {
        seen = input;
        return [];
      },
    });
    assert.ok(
      seen?.referenceAnalysedEcosystems.has("mock"),
      "notes never clear reference analysis",
    );
    const capability = result.findings.find((f) => f.rule === "adapter-capability");
    assert.equal(capability?.dependency, "vite-plugin");
    assert.equal(capability?.awareness, true);
    assert.equal(findingGroup(capability!), "awareness");
    const run = result.findings.find((f) => f.rule === "adapter-note");
    assert.equal(run?.dependency, undefined);
    assert.equal(run?.adapterNote, true);
    assert.equal(findingGroup(run!), "note");
    assert.ok(result.findings.every((f) => f.severity !== undefined));
  });

  it("leaves an unused verdict in the same run unaffected", async () => {
    const base = await analyseRepository(handle, {
      adapters: [adapter(undefined)],
      recommend: createDefaultPolicy(),
    });
    const withNotes = await analyseRepository(handle, {
      adapters: [adapter(async () => [{ statement: "graph edges unavailable" }])],
      recommend: createDefaultPolicy(),
    });
    const unused = (r: typeof base) =>
      r.findings
        .filter((f) => f.kind === "unused")
        .map((f) => [f.dependency, f.confidence, f.severity]);
    assert.ok(unused(base).length > 0, "fixture reaches an unused verdict");
    assert.deepEqual(unused(withNotes), unused(base));
    assert.equal(
      withNotes.findings.filter((f) => findingGroup(f) === "incomplete").length,
      base.findings.filter((f) => findingGroup(f) === "incomplete").length,
    );
  });

  it("keeps the analysis when notes() throws or hangs, with one incomplete note", async () => {
    for (const notes of [
      async () => {
        throw new Error("boom");
      },
      () => new Promise<never>(() => {}),
    ] as EcosystemAdapter["notes"][]) {
      const result = await analyseRepository(handle, {
        adapters: [adapter(notes)],
        adapterTimeoutMs: 200,
      });
      assert.deepEqual(result.dependencies.map((d) => d.name).sort(), ["left-pad", "vite-plugin"]);
      const failures = result.findings.filter((f) =>
        f.evidence.some((e) => e.kind === "adapter-error"),
      );
      assert.equal(failures.length, 1);
      assert.match(failures[0]!.summary, /notes/);
      assert.doesNotMatch(failures[0]!.summary, /notes timed out during notes/);
      assert.equal(findingGroup(failures[0]!), "incomplete");
    }
  });

  it("drops garbage notes() output silently", async () => {
    for (const notes of [
      async () => "nope" as never,
      async () => [null, 7, { statement: 5 }, { statement: "  " }] as never,
    ] as EcosystemAdapter["notes"][]) {
      const result = await analyseRepository(handle, { adapters: [adapter(notes)] });
      assert.equal(
        result.findings.filter((f) => f.rule === "adapter-note" || f.rule === "adapter-capability")
          .length,
        0,
      );
      assert.ok(!result.findings.some((f) => f.evidence.some((e) => e.kind === "adapter-error")));
    }
  });

  it("strips adapter-set markers from other adapter output", async () => {
    const result = await analyseRepository(handle, {
      adapters: [adapter(async () => [{ statement: "x" }])],
      recommend: () => [
        {
          kind: "info",
          rule: "sneaky",
          summary: "s",
          recommendation: "r",
          evidence: [],
          confidence: "high",
          adapterNote: true,
          limitations: [],
          affectedFiles: [],
        },
      ],
    });
    const sneaky = result.findings.find((f) => f.rule === "sneaky");
    assert.equal(sneaky?.adapterNote, undefined);
    assert.equal(findingGroup(sneaky!), "incomplete");
  });
});

describe("adapterNoteFindings", () => {
  const source = (notes: unknown) => ({
    ecosystem: "mock",
    notes,
    dependencies: [dep("a")],
  });

  it("drops notes naming a dependency the adapter did not list", () => {
    const out = adapterNoteFindings([
      source([
        { statement: "ok", dependency: "a" },
        { statement: "x", dependency: "not-listed" },
        { statement: "y", dependency: 3 },
      ]),
    ]);
    assert.deepEqual(
      out.map((f) => f.dependency),
      ["a"],
    );
  });

  it("dedupes identical notes and bounds statements", () => {
    const long = "z".repeat(MAX_ADAPTER_NOTE_CHARS * 2);
    const out = adapterNoteFindings([
      source([
        { statement: "same" },
        { statement: " same " },
        { statement: "same", dependency: "a" },
        { statement: `line\none\u202e${long}` },
      ]),
    ]);
    assert.equal(out.length, 3);
    const bounded = out[2]!.evidence[0]!.statement;
    assert.ok(!/[\n\u202e]/.test(bounded));
    assert.ok(out[2]!.summary.length <= "mock: ".length + MAX_ADAPTER_NOTE_CHARS);
  });

  it("caps at MAX_ADAPTER_NOTES per run across adapters, with one overflow note", () => {
    const many = (prefix: string) =>
      Array.from({ length: 70 }, (_, i) => ({ statement: `${prefix} ${i}` }));
    const out = adapterNoteFindings([source(many("p")), source(many("q"))]);
    assert.equal(out.length, MAX_ADAPTER_NOTES + 1);
    const overflow = out[MAX_ADAPTER_NOTES]!;
    assert.match(overflow.summary, /^40 more adapter note\(s\) not shown/);
    assert.equal(overflow.adapterNote, true);
  });

  it("bounds raw worker-posted notes without a limitation", () => {
    const outcome: AdapterOutcome = {
      ecosystem: "mock",
      dependencies: [],
      usages: [],
      graphs: [],
      usageAnalysed: false,
      findings: [],
      adapterNotes: Array.from({ length: MAX_ADAPTER_NOTES * 10 }, () => ({ statement: "s" })),
    };
    const capped = capOutcome(outcome);
    assert.equal((capped.adapterNotes as unknown[]).length, MAX_ADAPTER_NOTES * 4);
    assert.equal(capped.findings.length, 0);
  });
});
