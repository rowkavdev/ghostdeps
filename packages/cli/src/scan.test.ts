import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { analyseDirectory, createDefaultPolicy } from "@ghostdeps/core";
import { defaultAdapters } from "./adapters.js";
import { run, type Io } from "./cli.js";
import { runScan } from "./scan.js";
import { createStubPythonAdapter } from "./testing/stub-python-adapter.js";

/** Tests run from packages/cli/dist. */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/js/${name}`, import.meta.url));
const golden = (name: string): URL => new URL(`../test/golden/${name}`, import.meta.url);

/** Set UPDATE_GOLDEN=1 to rewrite golden files after an intended output change. */
function assertGolden(name: string, actual: string): void {
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden(name), actual);
  assert.equal(actual, readFileSync(golden(name), "utf8"));
}

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (m) => void out.push(m), stderr: (m) => void err.push(m) },
    out,
    err,
  };
}

describe("ghostdeps scan --json", () => {
  it("prints the schema-stable AnalysisResult for js/basic-unused (golden)", async () => {
    const { io, out, err } = capture();
    const code = await run(["scan", "--json", fixture("basic-unused")], io);
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(err, []);
    const text = `${out.join("\n")}\n`;
    const parsed = JSON.parse(text) as { schemaVersion: number; detected: { ecosystem: string }[] };
    assert.equal(parsed.schemaVersion, 1);
    assert.deepEqual(
      parsed.detected.map((d) => d.ecosystem),
      ["javascript-typescript"],
    );
    const findings = (JSON.parse(text) as { findings: { rule?: string; confidence?: string }[] })
      .findings;
    assert.ok(
      findings.some((f) => f.rule === "unused" && f.confidence === "medium"),
      "the default policy runs: fully analysed usage produces a real unused verdict (medium under the #178 cap)",
    );
    assertGolden("scan-js-basic-unused.json", text);
  });

  it("is byte-identical across runs", async () => {
    const a = capture();
    const b = capture();
    await run(["scan", "--json", fixture("usage-static-and-require")], a.io);
    await run(["--json", "--", fixture("usage-static-and-require")], b.io);
    assert.equal(a.out.join("\n"), b.out.join("\n"));
    assert.ok(a.out.join("\n").startsWith('{\n  "schemaVersion": 1,'));
  });

  it("reports a missing path as a JSON error, never an empty result", async () => {
    const { io, out } = capture();
    const code = await run(["scan", "--json", fixture("does-not-exist")], io);
    assert.equal(code, 2);
    const body = JSON.parse(out.join("\n")) as Record<string, unknown>;
    assert.equal((body["error"] as Record<string, unknown>)["code"], "error");
    assert.equal(body["schemaVersion"], undefined);
  });

  it("prints the canonical repository summary for js/basic-unused", async () => {
    const { io, out, err } = capture();
    const code = await run(["scan", fixture("basic-unused")], io);
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(err, []);
    const text = out.join("\n");
    assert.match(text, /^GhostDeps\n/);
    assert.match(text, /Languages:\n {2}JavaScript\/TypeScript\n/);
    assert.match(text, /Package managers:\n/);
    assert.match(text, /Direct dependencies:\n {2}\d/);
    // No lockfile: the graph completeness marker (#114) makes this unknown, never 0.
    assert.match(text, /Transitive dependencies:\n {2}unknown/);
    // The unused verdict must be visible in the summary: "Findings: none"
    // would read as an all-clear.
    assert.match(text, /Findings:\n {2}1 unused\n {2}2 info\n/);
    assert.match(text, /Verdicts:\n {2}unused:\n {4}left-pad - /);
    // Info findings stay visible as notes (#210), never hidden.
    assert.match(text, /Notes:\n {4}\(repository-wide\) - /);
  });

  it("reports a missing path as one clear error line, exit 2", async () => {
    const { io, out, err } = capture();
    const code = await run(["scan", fixture("does-not-exist")], io);
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.match(err.join(" "), /path is not a directory: .*does-not-exist/);
  });
});

describe("ghostdeps scan --fail-on / --severity", () => {
  it("exits 1 when a finding meets --fail-on, and still prints the report", async () => {
    const { io, out, err } = capture();
    const code = await run(["scan", "--fail-on", "info", fixture("basic-unused")], io);
    assert.equal(code, 1);
    assert.ok(out.join("\n").startsWith("GhostDeps\n"));
    assert.deepEqual(err, []);
  });

  it("exits 0 when every finding sits below the --fail-on gate (#110)", async () => {
    const a = capture();
    const codeA = await run(["scan", "--fail-on", "critical", fixture("basic-unused")], a.io);
    assert.equal(codeA, 0, a.err.join("\n"));
    // A low-confidence note never trips the high gate: downgraded findings
    // advise, they do not gate.
    const b = capture();
    const codeB = await run(
      ["scan", "--fail-on", "high", "--downgrade", "unused=low", fixture("basic-unused")],
      b.io,
    );
    assert.equal(codeB, 0, b.err.join("\n"));
  });

  it("rejects an unknown severity as a usage error", async () => {
    const { io, err } = capture();
    const code = await run(["scan", "--fail-on", "bogus", fixture("basic-unused")], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /unknown severity: bogus/);
  });

  it("--severity filters the human findings and says so", async () => {
    const { io, out } = capture();
    const code = await run(["scan", "--severity", "critical", fixture("basic-unused")], io);
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.match(text, /Findings:\n {2}none/);
    // The unused verdict plus the #178 confidence-cap note. The JS adapter
    // reports declaration lines (#198), so no declaration-line note.
    assert.match(text, /\(2 findings below the --severity critical filter hidden\)/);
  });

  // The polyglot fixture only yields awareness findings with the test-only
  // stub Python adapter in, so these call runScan with it injected.
  const polyglot = fileURLToPath(
    new URL("../../../fixtures/polyglot/js-app-python-service", import.meta.url),
  );
  const analyseWithStubPython = (path: string) =>
    analyseDirectory(path, {
      adapters: [...defaultAdapters(), createStubPythonAdapter()],
      network: { mode: "offline" },
      recommend: createDefaultPolicy({}),
    });

  it("exits 0 on --fail-on info when every finding is awareness-only (#234)", async () => {
    const { io, out } = capture();
    const code = await runScan(
      { command: "scan", json: false, path: polyglot, failOn: "info" },
      io,
      analyseWithStubPython,
    );
    assert.equal(code, 0);
    const text = out.join("\n");
    // Awareness findings never count: the tally is empty, the section shows.
    assert.match(text, /Findings:\n {2}none/);
    assert.match(text, /Awareness notes:\n {4}\S/);
  });

  it("--severity never counts awareness findings as hidden (#234)", async () => {
    const { io, out } = capture();
    const code = await runScan(
      { command: "scan", json: false, path: polyglot, severity: "critical" },
      io,
      analyseWithStubPython,
    );
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.ok(!text.includes("hidden"), text);
  });

  it("--json always prints the complete result; --severity with it is a usage error", async () => {
    const { io, err } = capture();
    const code = await run(["scan", "--severity", "high", "--json", fixture("basic-unused")], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /--severity filters human output only/);
  });

  it("--fail-on only applies to scan", async () => {
    const { io, err } = capture();
    const code = await run(["languages", "--fail-on", "high"], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /only apply to ghostdeps scan/);
  });
});

describe("ghostdeps scan policy flags", () => {
  it("--disable-rule turns a rule off for the run", async () => {
    const { io, out } = capture();
    const code = await run(
      ["scan", "--json", "--disable-rule", "unused", fixture("basic-unused")],
      io,
    );
    assert.equal(code, 0);
    const body = JSON.parse(out.join("\n")) as { findings: { rule?: string }[] };
    assert.equal(body.findings.length, 0);
  });

  it("rejects an unknown rule for --disable-rule", async () => {
    const { io, err } = capture();
    const code = await run(["scan", "--disable-rule", "unsed", fixture("basic-unused")], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /unknown rule for --disable-rule: unsed/);
    assert.match(err.join(" "), /unused, unverified-no-imports, type-only, should-be-dev/);
  });

  it("rejects an unknown rule for --downgrade", async () => {
    const { io, err } = capture();
    const code = await run(["scan", "--downgrade", "unsed=low", fixture("basic-unused")], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /unknown rule for --downgrade: unsed/);
  });

  it("rejects an unknown ecosystem for --allowlist", async () => {
    const { io, err } = capture();
    const code = await run(["scan", "--allowlist", "pythn:left-pad", fixture("basic-unused")], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /unknown ecosystem for --allowlist: pythn/);
    assert.match(err.join(" "), /javascript-typescript/);
  });

  it("rejects a malformed --downgrade as a usage error", async () => {
    const { io, err } = capture();
    const code = await run(["scan", "--downgrade", "unused=severe", fixture("basic-unused")], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /--downgrade wants <rule>=<confidence>/);
  });

  it("rejects a malformed --allowlist as a usage error", async () => {
    const { io, err } = capture();
    const code = await run(["scan", "--allowlist", "no-colon-here", fixture("basic-unused")], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /--allowlist wants <ecosystem>:<package>/);
  });

  it("--allowlist marks tooling as expected, quieting its note", async () => {
    const { io, out } = capture();
    const code = await run(
      ["scan", "--json", "--allowlist", "javascript-typescript:left-pad", fixture("basic-unused")],
      io,
    );
    assert.equal(code, 0);
    const body = JSON.parse(out.join("\n")) as { findings: { dependency?: string }[] };
    assert.ok(body.findings.every((f) => f.dependency !== "left-pad"));
  });

  it("policy flags only apply to scan", async () => {
    const { io, err } = capture();
    const code = await run(["languages", "--disable-rule", "unused"], io);
    assert.equal(code, 2);
    assert.match(err.join(" "), /only apply to ghostdeps scan/);
  });
});
