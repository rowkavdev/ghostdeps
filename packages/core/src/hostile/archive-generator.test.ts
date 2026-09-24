/**
 * Reproducibility check for the hostile archive generator (#103): the
 * committed fixtures/hostile/archive-* outputs must match a fresh run of
 * fixtures/hostile/generate.mjs byte-for-byte, so the generator and the
 * committed binaries can never drift. The generator runs in a temp dir
 * (it writes relative to its own path), nothing in the repo is touched.
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const hostileDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/hostile");

describe("hostile archive generator reproducibility (#103)", () => {
  it("regenerated archives match the committed ones byte-for-byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghostdeps-fixture-gen-"));
    try {
      await cp(join(hostileDir, "generate.mjs"), join(dir, "generate.mjs"));
      await promisify(execFile)(process.execPath, [join(dir, "generate.mjs")]);
      const fixtures = (await readdir(join(hostileDir), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("archive-"))
        .map((entry) => entry.name)
        .sort();
      assert.ok(fixtures.length > 0, "archive-* fixtures are missing");
      for (const fixture of fixtures) {
        for (const name of ["archive.tar.gz", "expected.json", "README.md"]) {
          const committed = await readFile(join(hostileDir, fixture, name));
          const generated = await readFile(join(dir, fixture, name));
          assert.ok(
            committed.equals(generated),
            `${fixture}/${name} differs from the generator output - rerun fixtures/hostile/generate.mjs and commit the result`,
          );
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
