import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { run, type Io } from "./cli.js";

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
    const findings = (JSON.parse(text) as { findings: { evidence: { kind: string }[] }[] })
      .findings;
    assert.ok(
      findings.some((f) => f.evidence[0]?.kind === "recommendation-policy-missing"),
      "a scan with no policy must say so, never print an empty all-clear",
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
    assert.equal(code, 1);
    const body = JSON.parse(out.join("\n")) as Record<string, unknown>;
    assert.equal((body["error"] as Record<string, unknown>)["code"], "error");
    assert.equal(body["schemaVersion"], undefined);
  });

  it("leaves human scan output unchanged until the summary renderer lands", async () => {
    const { io, out, err } = capture();
    const code = await run(["scan", fixture("basic-unused")], io);
    assert.equal(code, 3);
    assert.deepEqual(out, []);
    assert.match(err.join(" "), /ghostdeps scan is not implemented yet/);
  });
});
