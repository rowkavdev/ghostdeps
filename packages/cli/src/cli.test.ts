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

  it("treats `ghostdeps --json` as scan with JSON output", async () => {
    const { io, out } = capture();
    const code = await run(["--json"], io);
    assert.equal(code, 3);
    const result = jsonOut(out);
    assert.equal(result["schemaVersion"], 1);
  });

  it("stub commands exit non-zero with a clear message", async () => {
    const { io, err } = capture();
    const code = await run(["packages"], io);
    assert.equal(code, 3);
    assert.match(err.join(" "), /ghostdeps packages is not implemented yet/);
  });

  it("--json stubs emit a schema-shaped empty result on stdout", async () => {
    const { io, out, err } = capture();
    const code = await run(["scan", "--json"], io);
    assert.equal(code, 3);
    assert.match(err.join(" "), /not implemented/);
    const result = jsonOut(out);
    assert.equal(result["schemaVersion"], 1);
    for (const key of ["projects", "dependencies", "usages", "findings", "detected", "surface"]) {
      assert.deepEqual(result[key], [], `${key} should be an empty array`);
    }
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
