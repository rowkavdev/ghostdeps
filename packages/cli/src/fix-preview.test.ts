import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { run } from "./cli.js";

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "gd-cli-fix-"));
  await writeFile(
    join(root, "package.json"),
    text({
      name: "f",
      version: "1.0.0",
      packageManager: "npm@10.8.0",
      dependencies: { "left-pad": "^1.3.0" },
    }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    text({
      name: "f",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "f", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } },
        "node_modules/left-pad": { version: "1.3.0" },
      },
    }),
  );
  await writeFile(join(root, "index.js"), "export const one = 1;\n");
  return root;
};
const capture = () => {
  const out: string[] = [],
    err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (s: string) => {
        out.push(s);
      },
      stderr: (s: string) => {
        err.push(s);
      },
    },
  };
};
describe("ghostdeps fix dry-run (#389)", () => {
  it("previews both files without writes and reports status truthfully", async () => {
    const root = await fixture();
    try {
      const before = await Promise.all(
        ["package.json", "package-lock.json"].map((p) => readFile(join(root, p), "utf8")),
      );
      const c = capture();
      assert.equal(await run(["fix", "left-pad", root], c.io), 0, c.err.join("\n"));
      assert.match(c.out.join("\n"), /Status: statically checked, not applied/);
      assert.match(c.out.join("\n"), /--- a\/package-lock.json/);
      assert.deepEqual(
        await Promise.all(
          ["package.json", "package-lock.json"].map((p) => readFile(join(root, p), "utf8")),
        ),
        before,
      );
      const json = capture();
      assert.equal(await run(["fix", "--json", "left-pad", root], json.io), 0);
      assert.equal(JSON.parse(json.out[0]!).verification.sandbox, "not-run");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("previews v2 and names both lockfile sections in the diff", async () => {
    const root = await fixture();
    try {
      const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      await writeFile(
        join(root, "package.json"),
        text({ ...manifest, packageManager: "npm@8.19.4" }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        text({ ...lock, lockfileVersion: 2, dependencies: { "left-pad": { version: "1.3.0" } } }),
      );
      const before = await readFile(join(root, "package-lock.json"), "utf8");
      const c = capture();
      assert.equal(
        await run(["fix", "left-pad", root], c.io),
        0,
        c.out.join("\n") + c.err.join("\n"),
      );
      assert.match(c.out.join("\n"), /node_modules\/left-pad/);
      assert.match(c.out.join("\n"), /"left-pad": \{/);
      assert.equal(await readFile(join(root, "package-lock.json"), "utf8"), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("visible refusal and nonzero exit on unsupported manager", async () => {
    const root = await fixture();
    try {
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const c = capture();
      assert.equal(await run(["fix", "left-pad", root], c.io), 2);
      assert.match(c.out.join("\n"), /Fix preview refused: Another package manager/);
      assert.match(c.out.join("\n"), /No files changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
