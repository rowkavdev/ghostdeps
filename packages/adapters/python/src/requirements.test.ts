import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRef } from "@ghostdeps/core";
import {
  MAX_INCLUDE_DEPTH,
  parseRequirementsFiles,
  requirementsEntryPoints,
  requirementsKind,
  resolveInclude,
} from "./requirements.js";
import { memoryHandle } from "./testing/fs-handle.js";

const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };

async function parse(files: Record<string, string>, entries = ["requirements.txt"]) {
  return parseRequirementsFiles(memoryHandle(files), project, entries);
}
const names = (result: Awaited<ReturnType<typeof parse>>) =>
  result.requirements.map(
    (r) =>
      `${r.dependency.name} ${r.dependency.constraint} ${r.dependency.kind} ${r.dependency.declaredIn}`,
  );

describe("parseRequirementsFiles (issue #44)", () => {
  it("reads pins, ranges, extras, markers, comments and hashes", async () => {
    const result = await parse({
      "requirements.txt": [
        "# comment",
        "Django==5.0.1  # pinned",
        "requests[socks]>=2.31,<3",
        'tomli>=2 ; python_version < "3.11"',
        "cryptography==42.0.0 \\",
        "    --hash=sha256:aaa \\",
        "    --hash=sha256:bbb",
        "--index-url https://example.com/simple",
        "--pre",
        "",
      ].join("\n"),
    });
    assert.deepEqual(names(result), [
      "django ==5.0.1 runtime requirements.txt",
      "requests >=2.31,<3 runtime requirements.txt",
      "tomli >=2 runtime requirements.txt",
      "cryptography ==42.0.0 runtime requirements.txt",
    ]);
    assert.deepEqual(result.requirements[1]?.extras, ["socks"]);
    assert.equal(result.requirements[2]?.marker, 'python_version < "3.11"');
  });

  it("resolves -r includes relative to the including file", async () => {
    const result = await parse(
      {
        "requirements/dev.txt": "-r base.txt\npytest\n",
        "requirements/base.txt": "flask\n",
      },
      ["requirements/dev.txt"],
    );
    assert.deepEqual(names(result), [
      "flask * dev requirements/base.txt",
      "pytest * dev requirements/dev.txt",
    ]);
  });

  it("reads a shared base as runtime when it is also an entry point", async () => {
    const result = await parse(
      { "requirements.txt": "flask\n", "requirements-dev.txt": "-r requirements.txt\npytest\n" },
      ["requirements.txt", "requirements-dev.txt"],
    );
    assert.deepEqual(names(result), [
      "flask * runtime requirements.txt",
      "pytest * dev requirements-dev.txt",
    ]);
  });

  it("emits one Dependency per name and kind across files", async () => {
    const result = await parse(
      { "requirements.txt": "flask\n", "requirements/prod.txt": "flask>=3\ngunicorn\n" },
      ["requirements.txt", "requirements/prod.txt"],
    );
    assert.deepEqual(names(result), [
      "flask >=3 runtime requirements.txt",
      "gunicorn * runtime requirements/prod.txt",
    ]);
  });

  it("treats -c constraint files as pins, not declarations", async () => {
    const result = await parse({
      "requirements.txt": "-c constraints.txt\nflask\n",
      "constraints.txt": "werkzeug==3.0\n",
    });
    assert.deepEqual(names(result), ["flask * runtime requirements.txt"]);
  });

  it("never follows includes outside the repository or remote", async () => {
    const result = await parse({
      "requirements.txt": "-r ../../etc/passwd\n-r https://example.com/r.txt\n-r /abs.txt\n",
    });
    assert.equal(result.requirements.length, 0);
    assert.equal(
      result.evidence.filter((e) => e.kind === "requirements-include-skipped").length,
      3,
    );
  });

  it("survives include cycles and caps include depth", async () => {
    const cyc = await parse({
      "requirements.txt": "-r b.txt\na\n",
      "b.txt": "-r requirements.txt\nb\n",
    });
    assert.deepEqual(
      names(cyc)
        .map((n) => n.split(" ")[0])
        .sort(),
      ["a", "b"],
    );

    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_INCLUDE_DEPTH + 2; i++)
      files[i === 0 ? "requirements.txt" : `r${i}.txt`] = `-r r${i + 1}.txt\np${i}\n`;
    const deep = await parse(files);
    assert.ok(deep.evidence.some((e) => e.kind === "requirements-limit"));
  });

  it("notes missing includes", async () => {
    const result = await parse({ "requirements.txt": "-r nope.txt\n" });
    assert.equal(result.evidence[0]?.kind, "requirements-include-missing");
  });

  it("names editable and VCS requirements from #egg, and reports nameless ones", async () => {
    const result = await parse({
      "requirements.txt": [
        "-e git+https://example.com/lib.git@v1#egg=my_lib",
        "git+https://example.com/other.git",
        "-e .",
        "./local-pkg",
        "https://example.com/pkg-1.0.tar.gz#egg=pkg",
      ].join("\n"),
    });
    assert.deepEqual(
      result.requirements.map((r) => [r.dependency.name, r.dependency.specifier?.type]),
      [
        ["my-lib", "git"],
        ["pkg", "registry"],
      ],
    );
    assert.equal(result.evidence.filter((e) => e.kind === "requirement-unresolved").length, 3);
  });

  it("reports unparsable lines", async () => {
    const result = await parse({ "requirements.txt": "this is not valid\n" });
    assert.equal(result.evidence[0]?.kind, "requirement-unparsed");
  });
});

describe("requirements helpers", () => {
  it("classifies dev-flavoured files", () => {
    assert.equal(requirementsKind("requirements.txt"), "runtime");
    assert.equal(requirementsKind("requirements-dev.txt"), "dev");
    assert.equal(requirementsKind("test-requirements.txt"), "dev");
    assert.equal(requirementsKind("requirements/docs.txt"), "dev");
    assert.equal(requirementsKind("requirements/prod.txt"), "runtime");
  });

  it("resolves includes inside the repository only", () => {
    assert.equal(resolveInclude("a/b/requirements.txt", "../c.txt"), "a/c.txt");
    assert.equal(resolveInclude("requirements.txt", "../x.txt"), undefined);
    assert.equal(resolveInclude("r.txt", "C:\\x.txt"), undefined);
  });

  it("prefers pip-tools .in sources over compiled .txt output", () => {
    const { entries, evidence } = requirementsEntryPoints(project, [
      "requirements.in",
      "requirements.txt",
      "requirements/dev.txt",
      "docs/requirements.txt",
    ]);
    assert.deepEqual(entries, ["requirements.in", "requirements/dev.txt"]);
    assert.equal(evidence[0]?.kind, "requirements-compiled");
  });
});
