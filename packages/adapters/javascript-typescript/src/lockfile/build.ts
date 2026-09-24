/**
 * DependencyGraph construction for JS/TS projects from lockfiles only
 * (ADR 0004: no lockfile means an incomplete graph, never resolution).
 */
import type { AdapterContext, DependencyGraph, Evidence, ProjectRef } from "@ghostdeps/core";
import { assembleGraph, emptyGraph } from "./model.js";
import type { LockfileGraphResult, ParsedLockfile } from "./model.js";
import { parseNpmLockfile } from "./npm.js";
import { parsePnpmLockfile } from "./pnpm.js";

/**
 * Lockfiles above this size are not parsed (security-model: parser input
 * limits). Matches the repository scanner's lockfile ceiling (#73). Budget: a 30,000-package lockfile parses in well under 5 s on CI
 * hardware (see build.test.ts).
 */
export const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;

type Format = "npm" | "pnpm";
const LOCKFILES: [string, Format][] = [
  ["npm-shrinkwrap.json", "npm"],
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
];

const join = (dir: string, file: string) => (dir === "." || dir === "" ? file : `${dir}/${file}`);
const parent = (dir: string) => {
  if (dir === "." || dir === "") return undefined;
  const i = dir.lastIndexOf("/");
  return i < 0 ? "." : dir.slice(0, i);
};
const normalise = (p: string) => p.replace(/^\.\//, "").replace(/\/$/, "") || ".";

/** Relative path from lockfile dir to project dir, "." when equal. */
function relative(from: string, to: string): string {
  if (from === to) return ".";
  if (from === ".") return to;
  return to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to;
}

interface Declared {
  name: string;
  dev: boolean;
}

async function readDeclared(context: AdapterContext, project: string, evidence: Evidence[]) {
  const manifest = join(project, "package.json");
  const out: Declared[] = [];
  const seen = new Set<string>();
  try {
    const doc: unknown = JSON.parse(await context.repository.readFile(manifest));
    if (typeof doc !== "object" || doc === null) return out;
    const rec = doc as Record<string, unknown>;
    for (const [field, dev] of [
      ["dependencies", false],
      ["optionalDependencies", false],
      ["devDependencies", true],
    ] as const) {
      const map = rec[field];
      if (typeof map !== "object" || map === null || Array.isArray(map)) continue;
      for (const name of Object.keys(map)) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, dev });
      }
    }
  } catch {
    evidence.push({
      kind: "manifest-unreadable",
      statement: `${manifest} could not be read as JSON; the graph has no direct dependencies`,
      file: manifest,
    });
  }
  return out;
}

async function findLockfile(
  context: AdapterContext,
  project: ProjectRef,
  evidence: Evidence[],
): Promise<{ path: string; dir: string; format: Format } | undefined> {
  const preferred = new Set(project.packageManagers.map((pm) => pm.name));
  for (
    let dir: string | undefined = normalise(project.path);
    dir !== undefined;
    dir = parent(dir)
  ) {
    const found: { path: string; dir: string; format: Format }[] = [];
    for (const [file, format] of LOCKFILES) {
      const path = join(dir, file);
      if (await context.repository.exists(path)) found.push({ path, dir, format });
    }
    if (found.length === 0) continue;
    // npm-shrinkwrap.json wins over package-lock.json, as in npm itself.
    const unique = found.filter((f, i) => found.findIndex((g) => g.format === f.format) === i);
    if (unique.length > 1) {
      evidence.push({
        kind: "multiple-lockfiles",
        statement: `${unique.map((f) => f.path).join(" and ")} both exist; results use the detected package manager's lockfile`,
      });
      return unique.find((f) => preferred.has(f.format)) ?? unique[0];
    }
    return unique[0];
  }
  return undefined;
}

/** Build the lockfile graph for one project, with evidence. Never throws on bad input. */
export async function buildLockfileGraph(
  context: AdapterContext,
  project: ProjectRef,
): Promise<LockfileGraphResult> {
  const evidence: Evidence[] = [];
  const projectDir = normalise(project.path);
  const declared = await readDeclared(context, projectDir, evidence);
  const lock = await findLockfile(context, project, evidence);
  if (!lock) {
    evidence.push({
      kind: "lockfile-missing",
      statement: `no npm or pnpm lockfile found for ${projectDir}; transitive graph unknown`,
    });
    return { graph: emptyGraph(project), evidence };
  }
  let text: string;
  try {
    text = await context.repository.readFile(lock.path);
  } catch {
    evidence.push({
      kind: "lockfile-unreadable",
      statement: `could not read ${lock.path}`,
      file: lock.path,
    });
    return { graph: emptyGraph(project), evidence, lockfile: lock.path };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_LOCKFILE_BYTES) {
    evidence.push({
      kind: "lockfile-too-large",
      statement: `${lock.path} exceeds ${MAX_LOCKFILE_BYTES} bytes and was not parsed`,
      file: lock.path,
    });
    return { graph: emptyGraph(project), evidence, lockfile: lock.path };
  }
  const rel = relative(lock.dir, projectDir);
  let parsed: ParsedLockfile;
  try {
    parsed =
      lock.format === "npm"
        ? parseNpmLockfile(text, lock.path, rel === "." ? "" : rel, declared)
        : parsePnpmLockfile(text, lock.path, rel, declared);
  } catch (err) {
    evidence.push({
      kind: "lockfile-malformed",
      statement: `${lock.path} could not be parsed (${err instanceof Error ? err.message.split("\n")[0] : "unknown error"})`,
      file: lock.path,
    });
    return { graph: emptyGraph(project), evidence, lockfile: lock.path };
  }
  evidence.push(...parsed.evidence);
  const assembled = assembleGraph(project, parsed);
  evidence.push(...assembled.evidence);
  const graph = assembled.graph;
  const unsupported = parsed.evidence.some((e) => e.kind === "lockfile-unsupported");
  if (unsupported) graph.incomplete = true;
  return { graph, evidence, lockfile: lock.path };
}

/** EcosystemAdapter.buildDependencyGraph implementation. */
export async function buildDependencyGraph(
  context: AdapterContext,
  projects: ProjectRef[],
): Promise<DependencyGraph[]> {
  const out: DependencyGraph[] = [];
  for (const p of projects) out.push((await buildLockfileGraph(context, p)).graph);
  return out;
}
