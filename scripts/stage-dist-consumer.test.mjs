/** Explicit clean-consumer smoke for the experimental artifact, not a release action. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function invoke(command, args, cwd, timeout = 120_000) {
  // Windows npm is a .cmd shim; spawnSync cannot launch it without a shell.
  // Run the npm CLI with this job's Node instead of shelling out through cmd.
  if (command === "npm" && process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    assert.ok(existsSync(npmCli), `npm CLI missing alongside Node: ${npmCli}`);
    args = [npmCli, ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed (${result.status ?? result.error}):\n${result.stderr ?? ""}\n${result.stdout ?? ""}`,
  );
  return result.stdout;
}
const fixtures = new Map([
  ["javascript-typescript", "fixtures/js/basic-unused"],
  ["rust", "fixtures/rust/single-crate"],
  ["go", "fixtures/go/single-module"],
  ["python", "fixtures/python/pip-requirements"],
]);
function exercise(consumer) {
  const pkg = path.join(consumer, "node_modules/ghost-deps");
  const cli = path.join(pkg, "dist/main.js");
  const core = pathToFileURL(path.join(pkg, "dist/internal/core/index.js")).href;
  for (const [ecosystem, relative] of fixtures) {
    const fixture = path.join(root, relative);
    const result = JSON.parse(invoke(process.execPath, [cli, "scan", "--json", fixture], consumer));
    assert.ok(
      result.detected.some((item) => item.ecosystem === ecosystem),
      `${ecosystem} CLI scan did not detect fixture: ${JSON.stringify(result.detected)}`,
    );
    const script = `import { FsRepositoryHandle, analyseRepositoryIsolated } from ${JSON.stringify(core)};
const repo = await FsRepositoryHandle.open(${JSON.stringify(fixture)});
const result = await analyseRepositoryIsolated(repo, { adapters: [${JSON.stringify(`@ghostdeps/${ecosystem}`)}], adapterTimeoutMs: 30000 });
if (!result.detected.some(x => x.ecosystem === ${JSON.stringify(ecosystem)})) {
  console.error(JSON.stringify({ detected: result.detected, findings: result.findings })); process.exitCode = 3;
}`;
    const smoke = path.join(consumer, "worker-smoke.mjs");
    writeFileSync(smoke, script);
    invoke(process.execPath, [smoke], consumer, 60_000);
  }
  // Exercise the Rust parser rather than treating a copied .wasm file as proof.
  const parser = pathToFileURL(path.join(pkg, "dist/internal/rust/parser.js")).href;
  const wasmSmoke = path.join(consumer, "wasm-smoke.mjs");
  writeFileSync(
    wasmSmoke,
    `import { withRustTree, liveTreeCount } from ${JSON.stringify(parser)};
const names = await withRustTree("fn main() { let _x = 1; }", root => root.type);
if (names !== "source_file" || liveTreeCount() !== 0) process.exitCode = 4;`,
  );
  invoke(process.execPath, [wasmSmoke], consumer, 60_000);
}

// Run explicitly: STAGE_DIST_CONSUMER=1 node --test scripts/stage-dist-consumer.test.mjs
// STAGE_DIST_MANAGERS=npm limits a local run; the full gate requires npm,bun.
test(
  "prototype tarball works in clean npm and Bun consumers after prune/reinstall",
  { skip: process.env.STAGE_DIST_CONSUMER !== "1" },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ghostdeps-consumer-"));
    const stage = path.join(root, `.npm-dist-test-${process.pid}`);
    try {
      invoke(
        process.execPath,
        ["scripts/stage-dist-prototype.mjs", "--version", "0.1.999", "--out", stage],
        root,
      );
      const packed = JSON.parse(
        invoke("npm", ["pack", "--json", "--pack-destination", dir], stage),
      );
      const tarball = path.join(dir, packed[0].filename);
      for (const manager of (process.env.STAGE_DIST_MANAGERS ?? "npm,bun").split(",")) {
        assert.ok(["npm", "bun"].includes(manager), `unknown manager: ${manager}`);
        const consumer = path.join(dir, manager);
        mkdirSync(consumer, { recursive: true });
        writeFileSync(
          path.join(consumer, "package.json"),
          JSON.stringify({ name: "consumer", private: true, version: "1.0.0" }),
        );
        invoke(
          manager,
          manager === "npm"
            ? ["install", "--ignore-scripts", tarball]
            : ["add", "--ignore-scripts", tarball],
          consumer,
          180_000,
        );
        exercise(consumer);
        if (manager === "npm") invoke("npm", ["prune", "--ignore-scripts"], consumer);
        else {
          rmSync(path.join(consumer, "node_modules"), { recursive: true, force: true });
          invoke("bun", ["install", "--ignore-scripts"], consumer, 180_000);
        }
        exercise(consumer);
        rmSync(path.join(consumer, "node_modules"), { recursive: true, force: true });
        invoke(manager, ["install", "--ignore-scripts"], consumer, 180_000);
        exercise(consumer);
        const manifest = JSON.parse(readFileSync(path.join(consumer, "package.json"), "utf8"));
        assert.ok(
          Object.keys(manifest.dependencies).every((name) => !name.startsWith("@ghostdeps/")),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  },
);
