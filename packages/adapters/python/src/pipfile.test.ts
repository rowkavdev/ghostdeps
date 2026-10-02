import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRef } from "@ghostdeps/core";
import { parsePipfileText } from "./pipfile.js";

const project: ProjectRef = {
  path: ".",
  ecosystem: "python",
  packageManagers: [{ name: "pipenv" }],
};

describe("Pipfile declarations (#432)", () => {
  it("reads runtime and dev, table extras/markers, and exact declaration lines", () => {
    const parsed = parsePipfileText(
      '[packages]\npytz = "*"\nPyYAML = {version = ">=6", extras = ["speed"], markers = "python_version >= \'3.11\'"}\n[dev-packages]\npytest = "==8.*"\n',
      project,
      "Pipfile",
    );
    assert.equal(parsed.complete, true);
    assert.deepEqual(
      parsed.requirements.map((r) => [
        r.dependency.name,
        r.dependency.kind,
        r.dependency.constraint,
        r.dependency.declaredLine,
      ]),
      [
        ["pytz", "runtime", "*", 2],
        ["pyyaml", "runtime", ">=6", 3],
        ["pytest", "dev", "==8.*", 5],
      ],
    );
    assert.deepEqual(parsed.requirements[1]?.extras, ["speed"]);
    assert.equal(parsed.requirements[1]?.marker, "python_version >= '3.11'");
  });
  it("fails closed on unsupported or mistyped option tables", () => {
    for (const value of [
      "{git = 42}",
      "{markers = 42}",
      '{bogus = "not-a-constraint"}',
      '{extras = "speed"}',
      '{git = "https://example.com/repo.git", version = "*"}',
    ]) {
      const result = parsePipfileText(`[packages]\nfoo = ${value}\n`, project, "Pipfile");
      assert.equal(result.complete, false, value);
      assert.deepEqual(result.requirements, [], value);
      assert.ok(
        result.evidence.some((e) => e.kind === "manifest-malformed" && e.statement.includes("foo")),
        value,
      );
    }
  });
  it("never guesses runtime from missing or malformed sections", () => {
    const missing = parsePipfileText('[dev-packages]\npytest = "*"', project, "Pipfile");
    assert.equal(missing.complete, false);
    assert.equal(missing.requirements[0]?.dependency.kind, "dev");
    assert.ok(
      missing.evidence.some((e) => e.statement.includes("Pipfile runtime section not parsed")),
    );
    const malformed = parsePipfileText("[packages]\npytz = [", project, "Pipfile");
    assert.equal(malformed.malformed, true);
    assert.deepEqual(malformed.requirements, []);
  });
});

it("preserves Pipfile shorthand platform and version markers", () => {
  const parsed = parsePipfileText(
    '[packages]\npywin32 = {version = "*", sys_platform = "== \'win32\'"}\ncompat = {version = "*", python_version = "< \'3.11\'"}\n',
    project,
    "Pipfile",
  );
  assert.equal(parsed.complete, true);
  assert.equal(parsed.requirements[0]?.marker, "sys_platform == 'win32'");
  assert.equal(parsed.requirements[1]?.marker, "python_version < '3.11'");
});

it("combines full and shorthand markers without losing an OR arm's scope", () => {
  const parsed = parsePipfileText(
    "[packages]\ncompat = {version = \"*\", markers = \"os_name == 'nt' or os_name == 'posix'\", python_version = \"< '3.11'\"}\n",
    project,
    "Pipfile",
  );
  assert.equal(
    parsed.requirements[0]?.marker,
    "(os_name == 'nt' or os_name == 'posix') and (python_version < '3.11')",
  );
});

it("ignores a Pipfile shorthand value with no operator and the non-pipenv extra key", () => {
  const parsed = parsePipfileText(
    '[packages]\nbare = {version = "*", python_version = "3.10"}\nextra = {version = "*", extra = "== \'x\'"}\n',
    project,
    "Pipfile",
  );
  assert.equal(parsed.complete, true);
  assert.equal(parsed.requirements[0]?.marker, undefined);
  assert.equal(parsed.requirements[1]?.marker, undefined);
});

it("drops a Pipfile marker that does not parse, including unquoted shorthand values", () => {
  const parsed = parsePipfileText(
    [
      "[packages]",
      'unquoted = {version = "*", python_version = "< 3.11"}',
      'platform = {version = "*", sys_platform = "== win32"}',
      'badfull = {version = "*", markers = "python_version >="}',
      'mixed = {version = "*", markers = "os_name == \'nt\'", python_version = "< 3.11"}',
      'good = {version = "*", sys_platform = "== \'win32\'", platform_machine = "== \'x86_64\'"}',
      "",
    ].join("\n"),
    project,
    "Pipfile",
  );
  assert.equal(parsed.complete, true);
  const marker = (name: string) =>
    parsed.requirements.find((r) => r.dependency.name === name)?.marker;
  assert.equal(marker("unquoted"), undefined);
  assert.equal(marker("platform"), undefined);
  assert.equal(marker("badfull"), undefined);
  assert.equal(marker("mixed"), undefined);
  assert.equal(marker("good"), "(sys_platform == 'win32') and (platform_machine == 'x86_64')");
});

it("keeps parsing when a Pipfile marker is nested absurdly deep", () => {
  const deep = `${"(".repeat(20000)}os_name == 'nt'${")".repeat(20000)}`;
  const parsed = parsePipfileText(
    `[packages]\ndeep = {version = "*", markers = "${deep}"}\nplain = "*"\n`,
    project,
    "Pipfile",
  );
  assert.equal(parsed.complete, true);
  assert.equal(parsed.requirements.length, 2);
  assert.equal(parsed.requirements[0]?.marker, undefined);
});
