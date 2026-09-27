import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { run, type Io } from "./cli.js";

/**
 * CLI activation of repo-config fixture scope (#354): the entry point honours
 * a committed .ghostdeps.json, discloses it in human and JSON output, and
 * leaves runs without a config file byte-identical to before.
 */

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (m) => void out.push(m), stderr: (m) => void err.push(m) },
    out,
    err,
  };
}

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-cli-scope-"));
  roots.push(root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "root-project", dependencies: { "is-odd": "^3.0.1" } }),
  );
  // A manifest-only root reads as tooling noise to detection; one source file
  // makes it a real project.
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.js"), "module.exports = 1;\n");
  return root;
}
async function writeConfig(root: string, config: unknown): Promise<void> {
  await writeFile(
    path.join(root, ".ghostdeps.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("scan fixture scope activation (#354)", () => {
  it("honours .ghostdeps.json and discloses the exclusion in JSON and human output", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, "fixtures"), { recursive: true });
    await writeFile(
      path.join(root, "fixtures", "package.json"),
      JSON.stringify({ name: "fixture-project", dependencies: { leftpad: "^1.0.0" } }),
    );
    await writeConfig(root, { schemaVersion: 1, fixtureRoots: ["fixtures"] });

    const json = capture();
    const code = await run(["scan", "--json", root], json.io);
    assert.equal(code, 0, json.err.join("\n"));
    const result = JSON.parse(json.out.join("\n")) as {
      scanScope?: {
        source: string;
        matchedRoots: number;
        excludedFiles: number;
        excludedManifests: number;
        roots: { root: string; matched: boolean; files: number; manifests: number }[];
      };
      dependencies: { name: string }[];
      findings: { kind: string; summary: string }[];
    };
    assert.equal(result.scanScope?.source, "repo-config");
    assert.deepEqual(result.scanScope?.roots, [
      { root: "fixtures", matched: true, files: 1, manifests: 1 },
    ]);
    assert.equal(result.scanScope?.excludedFiles, 1);
    assert.equal(result.scanScope?.excludedManifests, 1);
    const names = result.dependencies.map((d) => d.name);
    assert.ok(names.includes("is-odd"), "the analysed project is still reported");
    assert.ok(!names.includes("leftpad"), "the excluded fixture manifest is not analysed");
    assert.ok(
      result.findings.some((f) => f.summary.includes("fixture scope omitted 1 file")),
      "the omission note names what was hidden",
    );

    const human = capture();
    assert.equal(await run(["scan", root], human.io), 0, human.err.join("\n"));
    const text = human.out.join("\n");
    assert.match(text, /Scan scope:/);
    assert.match(text, /fixtures: 1 files, 1 recognised manifests excluded/);
  });

  it("shows an unmatched root literally and never treats it as hiding anything", async () => {
    const root = await tempRepo();
    await writeConfig(root, { schemaVersion: 1, fixtureRoots: ["missing"] });

    const { io, out, err } = capture();
    const code = await run(["scan", "--json", root], io);
    assert.equal(code, 0, err.join("\n"));
    const result = JSON.parse(out.join("\n")) as {
      scanScope?: {
        source: string;
        matchedRoots: number;
        excludedFiles: number;
        roots: { root: string; matched: boolean }[];
      };
      findings: { summary: string }[];
    };
    assert.equal(result.scanScope?.source, "repo-config");
    assert.deepEqual(result.scanScope?.roots, [
      { root: "missing", matched: false, files: 0, manifests: 0 },
    ]);
    assert.equal(result.scanScope?.matchedRoots, 0);
    assert.equal(result.scanScope?.excludedFiles, 0);
    assert.ok(
      !result.findings.some((f) => f.summary.includes("fixture scope omitted")),
      "an all-unmatched config omits nothing and adds no omission note",
    );
  });

  it("keeps a repo without .ghostdeps.json on the legacy output with no scope field", async () => {
    const root = await tempRepo();

    const json = capture();
    assert.equal(await run(["scan", "--json", root], json.io), 0, json.err.join("\n"));
    const result = JSON.parse(json.out.join("\n")) as { scanScope?: unknown };
    assert.equal(result.scanScope, undefined);

    const human = capture();
    assert.equal(await run(["scan", root], human.io), 0, human.err.join("\n"));
    assert.ok(!human.out.join("\n").includes("Scan scope:"));
  });

  it("fails the scan visibly on a malformed config instead of ignoring it", async () => {
    const root = await tempRepo();
    await writeConfig(root, '{"schemaVersion":2,"fixtureRoots":[]}');

    const { io, out, err } = capture();
    const code = await run(["scan", "--json", root], io);
    assert.equal(code, 2, "an unreadable scope config is a scan error, never a clean result");
    assert.ok(
      err.join("\n").includes(".ghostdeps.json") || out.join("\n").includes(".ghostdeps.json"),
      "the error names the config file",
    );
  });
});
