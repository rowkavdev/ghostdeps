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
