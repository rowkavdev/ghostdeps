import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "./cli.js";

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (message) => {
      out.push(message);
    },
    stderr: (message) => {
      err.push(message);
    },
  };
  return { io, out, err };
}

function jsonOut(out: string[]): Record<string, unknown> {
  return JSON.parse(out.join("\n")) as Record<string, unknown>;
}

describe("ghostdeps cli", () => {
  it("--help lists every planned command", async () => {
    const { io, out } = capture();
    const code = await run(["--help"], io);
    assert.equal(code, 0);
    const text = out.join("\n");
    for (const command of ["scan", "inspect", "graph", "languages", "packages", "explain"]) {
      assert.ok(text.includes(command), `help should mention ${command}`);
    }
  });

  it("prints help when invoked with no arguments", async () => {
    const { io, out } = capture();
    const code = await run([], io);
    assert.equal(code, 0);
    assert.ok(out.join("\n").includes("Usage:"));
  });

  it("--version prints the package version", async () => {
    const { io, out } = capture();
    const code = await run(["--version"], io);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /^ghostdeps \d+\.\d+\.\d+$/);
  });

  it("rejects unknown options with a usage error", async () => {
    const { io, err } = capture();
    const code = await run(["--bogus"], io);
    assert.equal(code, 2);
    assert.ok(err.join(" ").includes("unknown option: --bogus"));
  });

  it("routes a bare path to scan (ghostdeps .)", async () => {
    const { io, out, err } = capture();
    const code = await run(["."], io);
    assert.equal(code, 0, err.join("\n"));
    assert.ok(out.join("\n").startsWith("GhostDeps\n"));
  });

  it("routes a bare existing directory to scan", async () => {
    const { io, out, err } = capture();
    const code = await run(["src"], io);
    assert.equal(code, 0, err.join("\n"));
    assert.ok(out.join("\n").startsWith("GhostDeps\n"));
  });

  it("rejects a mistyped command with a suggestion", async () => {
    const { io, err } = capture();
    const code = await run(["langauges"], io);
    assert.equal(code, 2);
    const text = err.join(" ");
    assert.ok(text.includes("unknown command: langauges"), text);
    assert.ok(text.includes("did you mean 'languages'?"), text);
  });

  it("treats `ghostdeps --json` as scan with JSON output", async () => {
    const { io, out } = capture();
    const fixture = new URL("../../../fixtures/js/basic-unused", import.meta.url).pathname;
    const code = await run(["--json", "--", fixture], io);
    assert.equal(code, 0);
    assert.equal(jsonOut(out)["schemaVersion"], 1);
  });

  it("treats a flag-only --severity invocation as scan, never silent help + exit 0", async () => {
    const { io, out, err } = capture();
    const code = await run(["--severity", "high"], io);
    assert.equal(code, 0, err.join("\n"));
    const text = out.join("\n");
    assert.ok(!text.includes("Usage:"), "must not print general help");
    assert.ok(text.startsWith("GhostDeps\n"), text);
  });

  it("flag-only --fail-on behaves exactly like ghostdeps scan --fail-on", async () => {
    const explicit = capture();
    const explicitCode = await run(["scan", "--fail-on", "critical"], explicit.io);
    const flagOnly = capture();
    const flagCode = await run(["--fail-on", "critical"], flagOnly.io);
    assert.equal(flagCode, explicitCode);
    assert.deepEqual(flagOnly.out, explicit.out);
  });

  it("flag-only --fixture-roots is a usage error naming scan and fix", async () => {
    const { io, out, err } = capture();
    const code = await run(["--fixture-roots", '{"version":1,"roots":[]}'], io);
    assert.equal(code, 2);
    assert.ok(!out.join("\n").includes("Usage:"), "must not print general help");
    assert.ok(err.join(" ").includes("--fixture-roots needs a command"), err.join(" "));
  });

  it("stub commands exit non-zero with a clear message", async () => {
    const { io, err } = capture();
    const code = await run(["packages"], io);
    assert.equal(code, 3);
    assert.match(err.join(" "), /ghostdeps packages is not implemented yet/);
  });

  it("--json stubs emit an error object, never an AnalysisResult", async () => {
    const { io, out, err } = capture();
    const code = await run(["packages", "--json"], io);
    assert.equal(code, 3);
    assert.match(err.join(" "), /not implemented/);
    const result = jsonOut(out);
    assert.equal((result["error"] as Record<string, unknown>)["code"], "not-implemented");
    assert.equal(result["schemaVersion"], undefined, "must not look like an AnalysisResult");
    assert.equal(result["findings"], undefined);
  });

  it("--json usage errors emit an error object", async () => {
    const { io, out } = capture();
    const code = await run(["inspect", "--json"], io);
    assert.equal(code, 2);
    assert.equal((jsonOut(out)["error"] as Record<string, unknown>)["code"], "usage");
  });

  it("inspect requires a package name", async () => {
    const { io, err } = capture();
    const code = await run(["inspect"], io);
    assert.equal(code, 2);
    assert.ok(err.join(" ").includes("needs a package name"));
  });

  it("rejects extra positional arguments", async () => {
    const { io } = capture();
    assert.equal(await run(["scan", "a", "b"], io), 2);
  });

  it("treats everything after -- as positional", async () => {
    const { io, err } = capture();
    const code = await run(["--", "-odd-dir"], io);
    assert.equal(code, 2);
    assert.ok(
      err.join(" ").includes("path is not a directory: -odd-dir"),
      "-odd-dir should route to scan",
    );
  });

  it("help <command> shows command-specific help", async () => {
    const { io, out } = capture();
    const code = await run(["help", "scan"], io);
    assert.equal(code, 0);
    assert.ok(out.join("\n").includes("ghostdeps scan"));
  });

  it("help with an unknown command is a usage error", async () => {
    const { io } = capture();
    assert.equal(await run(["help", "bogus"], io), 2);
  });
});

describe("PR-comment disclosure", () => {
  async function repoWithConfig(config?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ghostdeps-comments-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "example", dependencies: {} }),
    );
    if (config !== undefined) await writeFile(join(dir, ".ghostdeps.json"), config);
    return dir;
  }

  it("discloses the committed .ghostdeps.json opt-out", async () => {
    const dir = await repoWithConfig(
      JSON.stringify({ schemaVersion: 1, fixtureRoots: [], commentsOff: true }),
    );
    const { io, out, err } = capture();
    const code = await run(["scan", dir], io);
    assert.equal(code, 0, err.join("\n"));
    assert.ok(
      out.join("\n").includes("Comments: off (.ghostdeps.json)"),
      "committed opt-out is disclosed",
    );
  });

  it("a per-run payload saying true records the run as off, App follows the committed file", async () => {
    const dir = await repoWithConfig();
    const { io, out, err } = capture();
    const code = await run(
      ["scan", dir, "--fixture-roots", '{"schemaVersion":1,"fixtureRoots":[],"commentsOff":true}'],
      io,
    );
    assert.equal(code, 0, err.join("\n"));
    const text = out.join("\n");
    assert.ok(text.includes("Comments: off (--fixture-roots)"), "payload off-state disclosed");
    assert.ok(
      text.includes("App's comment delivery follows the committed .ghostdeps.json"),
      "enforcement boundary named",
    );
  });

  it("a per-run payload saying false cannot undo the committed opt-out for the App", async () => {
    const dir = await repoWithConfig(
      JSON.stringify({ schemaVersion: 1, fixtureRoots: [], commentsOff: true }),
    );
    const { io, out, err } = capture();
    const code = await run(
      ["scan", dir, "--fixture-roots", '{"schemaVersion":1,"fixtureRoots":[],"commentsOff":false}'],
      io,
    );
    assert.equal(code, 0, err.join("\n"));
    const text = out.join("\n");
    assert.ok(text.includes("Comments: off (.ghostdeps.json)"), "committed file still governs");
    assert.ok(text.includes("commentsOff: false for this run"), "disagreement is loud");
  });

  it("stays silent when neither the payload nor the committed file opts out", async () => {
    const dir = await repoWithConfig();
    const { io, out, err } = capture();
    const code = await run(
      ["scan", dir, "--fixture-roots", '{"schemaVersion":1,"fixtureRoots":[],"commentsOff":false}'],
      io,
    );
    assert.equal(code, 0, err.join("\n"));
    assert.ok(!out.join("\n").includes("Comments: off"), "no off-state to disclose");
  });
});
