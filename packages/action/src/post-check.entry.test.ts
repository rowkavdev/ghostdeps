import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("does not emit workflow commands through entry-point errors", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./post-check.js", import.meta.url)), "unused.json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "acme/demo",
        GITHUB_EVENT_PATH: "missing%file\r\n::error title=forged::injected",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "could not parse GITHUB_EVENT_PATH (missing%25file%0D%0A::error title=forged::injected)\n",
  );
  assert.ok(!result.stderr.split(/\r?\n/).some((line) => line.startsWith("::error")));
});
