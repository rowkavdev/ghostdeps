import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_GOMOD_BYTES, parseGoMod } from "./gomod.js";

describe("parseGoMod", () => {
  it("reads module, go, toolchain and a require block with indirect markers", () => {
    const mod = parseGoMod(
      [
        "// leading comment",
        "module example.com/app // Deprecated: use example.com/app/v2",
        "",
        "go 1.22.3",
        "toolchain go1.23.1",
        "",
        "require (",
        "\tgithub.com/spf13/cobra v1.8.0",
        "\tgolang.org/x/sys v0.20.0 // indirect",
        "\tgithub.com/pkg/errors v0.9.1 // indirect; kept for older callers",
        '\t"gopkg.in/yaml.v3" v3.0.1',
        ")",
        "require github.com/google/uuid v1.6.0",
      ].join("\n"),
    );
    assert.deepEqual(mod.module, {
      path: "example.com/app",
      line: 2,
      deprecated: "use example.com/app/v2",
    });
    assert.equal(mod.go, "1.22.3");
    assert.equal(mod.toolchain, "go1.23.1");
    assert.deepEqual(
      mod.require.map((r) => [r.path, r.version, r.indirect, r.line]),
      [
        ["github.com/spf13/cobra", "v1.8.0", false, 8],
        ["golang.org/x/sys", "v0.20.0", true, 9],
        ["github.com/pkg/errors", "v0.9.1", true, 10],
        ["gopkg.in/yaml.v3", "v3.0.1", false, 11],
        ["github.com/google/uuid", "v1.6.0", false, 13],
      ],
    );
    assert.deepEqual(mod.errors, []);
  });

  it("only treats a leading `indirect` comment as the marker", () => {
    const mod = parseGoMod(
      "module m\nrequire (\n\ta.example/x v1.0.0 // not indirect\n\tb.example/y v1.0.0 // indirectly\n)\n",
    );
    assert.deepEqual(
      mod.require.map((r) => r.indirect),
      [false, false],
    );
  });

  it("handles replace forms: module, versioned lhs, local directory", () => {
    const mod = parseGoMod(
      [
        "module m",
        "replace github.com/a/b => github.com/fork/b v1.2.3",
        "replace (",
        "\tgithub.com/c/d v1.0.0 => ../d",
        "\texample.com/e => ./local/e",
        "\texample.com/f => /abs/f",
        ")",
      ].join("\n"),
    );
    assert.deepEqual(mod.replace, [
      {
        old: { path: "github.com/a/b" },
        new: { path: "github.com/fork/b", version: "v1.2.3" },
        local: false,
        line: 2,
      },
      {
        old: { path: "github.com/c/d", version: "v1.0.0" },
        new: { path: "../d" },
        local: true,
        line: 4,
      },
      { old: { path: "example.com/e" }, new: { path: "./local/e" }, local: true, line: 5 },
      { old: { path: "example.com/f" }, new: { path: "/abs/f" }, local: true, line: 6 },
    ]);
    assert.deepEqual(mod.errors, []);
  });

  it("reads exclude, retract (single and interval) and tool directives", () => {
    const mod = parseGoMod(
      [
        "module m",
        "exclude golang.org/x/net v0.1.0",
        "exclude (",
        "\tgolang.org/x/text v0.3.0",
        ")",
        "retract v1.0.1 // published by mistake",
        "retract [v1.1.0, v1.1.5]",
        "tool golang.org/x/tools/cmd/stringer",
        "godebug default=go1.21",
      ].join("\n"),
    );
    assert.deepEqual(
      mod.exclude.map((e) => [e.path, e.version]),
      [
        ["golang.org/x/net", "v0.1.0"],
        ["golang.org/x/text", "v0.3.0"],
      ],
    );
    assert.deepEqual(
      mod.retract.map((r) => [r.low, r.high]),
      [
        ["v1.0.1", "v1.0.1"],
        ["v1.1.0", "v1.1.5"],
      ],
    );
    assert.deepEqual(mod.tool, [{ path: "golang.org/x/tools/cmd/stringer", line: 8 }]);
    assert.deepEqual(mod.errors, []);
  });

  it("accepts raw strings and CRLF line endings", () => {
    const mod = parseGoMod("module `example.com/raw`\r\nrequire `a.example/x` v1.0.0\r\n");
    assert.equal(mod.module?.path, "example.com/raw");
    assert.deepEqual(
      mod.require.map((r) => [r.path, r.version]),
      [["a.example/x", "v1.0.0"]],
    );
  });

  it("reports malformed lines without dropping the rest of the file", () => {
    const mod = parseGoMod(
      [
        "module m",
        "require a.example/only-path",
        "replace b.example/x => b.example/y",
        "replace c.example/x => ./dir v1.0.0",
        'require "unterminated v1.0.0',
        "require (",
        "\td.example/ok v1.0.0",
        "\te.example/bad",
      ].join("\n"),
    );
    assert.deepEqual(
      mod.require.map((r) => r.path),
      ["d.example/ok"],
    );
    assert.deepEqual(
      mod.errors.map((e) => e.line),
      [2, 3, 4, 5, 8, 6],
    );
  });

  it("rejects a repeated module directive and keeps the first", () => {
    const mod = parseGoMod("module a\nmodule b\n");
    assert.equal(mod.module?.path, "a");
    assert.equal(mod.errors.length, 1);
  });

  it("returns an empty result for empty input", () => {
    const mod = parseGoMod("");
    assert.equal(mod.module, undefined);
    assert.deepEqual(mod.require, []);
    assert.deepEqual(mod.errors, []);
  });

  it("rejects paren lines inside a block instead of reading fake requirements (#227)", () => {
    const mod = parseGoMod(
      [
        "module m",
        "require (",
        "\ta.example/x v1.0.0",
        "\trequire (",
        "\tb.example/y v1.0.0",
        ")",
        "replace (",
        "\tc.example/z ( => ./z",
        ")",
      ].join("\n"),
    );
    assert.deepEqual(
      mod.require.map((r) => r.path),
      ["a.example/x", "b.example/y"],
    );
    assert.deepEqual(mod.replace, []);
    assert.deepEqual(
      mod.errors.map((e) => e.line),
      [4, 8],
    );
  });

  it('does not take a quoted "=>" as the replace arrow (#227)', () => {
    const mod = parseGoMod('module m\nreplace a.example/x "=>" ./x\n');
    assert.deepEqual(mod.replace, []);
    assert.equal(mod.errors.length, 1);
  });

  it("reports a go.mod over the size cap without parsing it (#227)", () => {
    const big = "module m\n" + "// pad\n".repeat(MAX_GOMOD_BYTES / 7 + 1);
    const mod = parseGoMod(big);
    assert.equal(mod.module, undefined);
    assert.deepEqual(
      mod.errors.map((e) => e.line),
      [0],
    );
  });

  it("accepts a one-line empty block: require () (#227)", () => {
    const mod = parseGoMod("module m\nrequire ()\nreplace ( )\n");
    assert.deepEqual(mod.require, []);
    assert.deepEqual(mod.errors, []);
  });
});
