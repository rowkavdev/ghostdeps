/**
 * Runs the inert extraction helper against the hostile archive corpus in
 * fixtures/hostile/archive-*. Each fixture's expected.json is the contract:
 * either a rejection with a specific ExtractionError code (and nothing left
 * on disk) or a clean extraction with exact entry counts. See
 * fixtures/hostile/README.md; regenerate archives with
 * `node fixtures/hostile/generate.mjs`.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ExtractionError, type ExtractionErrorCode } from "./errors.js";
import { extractTarball, type ExtractionLimits } from "./extract.js";

const hostileDir = fileURLToPath(new URL("../../../../fixtures/hostile", import.meta.url));

interface Expected {
  description: string;
  archive: string;
  limits?: Partial<ExtractionLimits>;
  expect:
    | { result: "reject"; code: ExtractionErrorCode }
    | {
        result: "extract";
        files?: number;
        symlinks?: number;
        directories?: number;
        links?: { path: string; target: string }[];
      };
}

const fixtures = (await readdir(hostileDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("archive-"))
  .map((entry) => entry.name)
  .sort();

assert.ok(fixtures.length > 0, "hostile archive fixtures are missing");

describe("hostile archive fixtures", () => {
  for (const fixture of fixtures) {
    it(fixture, async () => {
      const dir = join(hostileDir, fixture);
      const expected: Expected = JSON.parse(await readFile(join(dir, "expected.json"), "utf8"));
      const dest = await mkdtemp(join(tmpdir(), "ghostdeps-hostile-"));
      await rm(dest, { recursive: true, force: true }); // extractTarball creates it fresh

      if (expected.expect.result === "reject") {
        const code = expected.expect.code;
        await assert.rejects(
          extractTarball(createReadStream(join(dir, expected.archive)), {
            destDir: dest,
            ...(expected.limits ? { limits: expected.limits } : {}),
          }),
          (error: unknown) => {
            assert.ok(error instanceof ExtractionError, `expected ExtractionError, got ${error}`);
            assert.equal(
              error.code,
              code,
              `${fixture}: expected ${code}, got ${error.code} (${error.message})`,
            );
            return true;
          },
        );
        // All-or-nothing: a rejected extraction leaves no checkout behind.
        await assert.rejects(stat(dest), /ENOENT/);
        return;
      }

      const summary = await extractTarball(createReadStream(join(dir, expected.archive)), {
        destDir: dest,
        ...(expected.limits ? { limits: expected.limits } : {}),
      });
      if (expected.expect.files !== undefined) assert.equal(summary.files, expected.expect.files);
      if (expected.expect.symlinks !== undefined)
        assert.equal(summary.symlinks, expected.expect.symlinks);
      if (expected.expect.directories !== undefined)
        assert.equal(summary.directories, expected.expect.directories);
      if (expected.expect.links !== undefined)
        assert.deepEqual(summary.links, expected.expect.links, `${fixture} recorded links`);
      await rm(dest, { recursive: true, force: true });
    });
  }
});
