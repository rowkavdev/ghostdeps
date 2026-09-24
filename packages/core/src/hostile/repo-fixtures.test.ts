/**
 * Validates the parser-hostile repository fixture corpus in
 * fixtures/hostile/repo-*: every expected.json must use the documented
 * assertion vocabulary (fixtures/hostile/README.md), carry the fields
 * that assert requires, use Confidence values from the core types, and
 * stay in sync with its README. Nothing here analyses the fixtures -
 * adapter lanes wire that in as their parsers land. This test exists so a
 * typo in an assert name, a wrong value, or README drift fails CI instead
 * of rotting until a lane wires the fixture in.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { Confidence } from "../types/index.js";

const hostileDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/hostile");

const CONFIDENCE_VALUES: readonly Confidence[] = ["high", "medium", "low"];

/** The documented vocabulary: assert name -> required extra fields. */
const VOCABULARY: Record<
  string,
  { required: string[]; enumFields?: Record<string, readonly string[]> }
> = {
  "parse.mustNotCrash": { required: [] },
  "detection.excludes": { required: ["ecosystem"] },
  "dependencies.includes": { required: ["dependency"] },
  "dependencies.excludes": { required: ["dependency"] },
  "unused.excludes": { required: ["dependency"] },
  "projects.includes": { required: ["path"] },
  "projects.excludes": { required: ["path"] },
  "limitations.includes": { required: ["contains"] },
  "confidence.atMost": { required: ["value"], enumFields: { value: CONFIDENCE_VALUES } },
};

interface Expectation {
  assert: string;
  why: string;
  [key: string]: unknown;
}

interface RepoFixtureContract {
  description: string;
  posixOnly?: boolean;
  expectations: Expectation[];
}

const fixtures = (await readdir(hostileDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("repo-"))
  .map((entry) => entry.name)
  .sort();

assert.ok(fixtures.length > 0, "repo-* fixtures are missing");

describe("repo fixture contracts", () => {
  for (const fixture of fixtures) {
    it(fixture, async () => {
      const dir = join(hostileDir, fixture);
      const contract: RepoFixtureContract = JSON.parse(
        await readFile(join(dir, "expected.json"), "utf8"),
      );

      assert.equal(typeof contract.description, "string", "description must be a string");
      assert.ok(contract.description.length > 0, "description must not be empty");
      if (contract.posixOnly !== undefined)
        assert.equal(typeof contract.posixOnly, "boolean", "posixOnly must be a boolean");
      assert.ok(Array.isArray(contract.expectations), "expectations must be an array");
      assert.ok(contract.expectations.length > 0, "expectations must not be empty");

      const allowedFields = new Set(["assert", "why"]);
      for (const expectation of contract.expectations) {
        const spec = VOCABULARY[expectation.assert];
        assert.ok(
          spec,
          `unknown assert '${expectation.assert}' - not in the documented vocabulary`,
        );
        assert.equal(
          typeof expectation.why,
          "string",
          `${expectation.assert}: why must be a string`,
        );
        assert.ok(expectation.why.length > 0, `${expectation.assert}: why must not be empty`);
        for (const field of spec.required) {
          assert.equal(
            typeof expectation[field],
            "string",
            `${expectation.assert}: missing required field '${field}'`,
          );
          assert.ok(
            (expectation[field] as string).length > 0,
            `${expectation.assert}: field '${field}' must not be empty`,
          );
        }
        for (const [field, values] of Object.entries(spec.enumFields ?? {}))
          assert.ok(
            values.includes(expectation[field] as string),
            `${expectation.assert}: field '${field}' must be one of ${values.join(", ")}`,
          );
        for (const field of Object.keys(expectation))
          assert.ok(
            allowedFields.has(field) || spec.required.includes(field),
            `${expectation.assert}: unexpected field '${field}'`,
          );
      }

      // The README must document the same contract as expected.json.
      const readme = await readFile(join(dir, "README.md"), "utf8");
      for (const expectation of contract.expectations)
        assert.ok(
          readme.includes(expectation.assert),
          `README.md does not mention '${expectation.assert}' - README and expected.json have drifted`,
        );

      // A fixture with no hostile content tests nothing.
      const files = await readdir(dir);
      assert.ok(
        files.some((name) => name !== "README.md" && name !== "expected.json"),
        "fixture has no content beyond README.md and expected.json",
      );
    });
  }
});
