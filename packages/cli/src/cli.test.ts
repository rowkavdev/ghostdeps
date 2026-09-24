import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    const { io, err } = capture();
    const code = await run(["."], io);
    assert.equal(code, 3);
    assert.ok(err.join(" ").includes("ghostdeps scan"));
  });

  it("routes a bare existing directory to scan", async () => {
    const { io, err } = capture();
    const code = await run(["src"], io);
    assert.equal(code, 3);
    assert.ok(err.join(" ").includes("ghostdeps scan"));
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
    assert.equal(code, 3);
    assert.ok(err.join(" ").includes("ghostdeps scan"), "-odd-dir should route to scan");
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
