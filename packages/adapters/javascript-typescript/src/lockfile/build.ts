/**
 * DependencyGraph construction for JS/TS projects from lockfiles only
 * (ADR 0004: no lockfile means an incomplete graph, never resolution).
 */
import type { AdapterContext, DependencyGraph, Evidence, ProjectRef } from "@ghostdeps/core";
import { assembleGraph, emptyGraph } from "./model.js";
import type { LoadedLockfile, LockfileGraphResult, ParsedLockfile } from "./model.js";
import { loadNpmLockfile, parseNpmLockfile } from "./npm.js";
import { loadPnpmLockfile, parsePnpmLockfile } from "./pnpm.js";
import { loadYarnLockfile, parseYarnLockfile } from "./yarn.js";
import { loadBunLockfile, parseBunLockfile } from "./bun.js";

/**
 * Lockfiles above this size are not parsed; the oversize lockfile is
 * reported as a limitation (security-model: parser input limits, and #89's
 * rule that oversize input surfaces as evidence, never a silent skip). The
 * cap itself lives in core (issue #89 single source) and is re-exported
 * here so existing imports keep working. Budget: a 30,000-package lockfile
 * parses in well under 5 s on CI hardware (see build.test.ts).
 */
import { MAX_LOCKFILE_BYTES } from "@ghostdeps/core";

export { MAX_LOCKFILE_BYTES };

/** lockfile-manifest-mismatch entries kept individually per graph; the rest are summarised. */
export const MAX_MISMATCH_EVIDENCE = 50;

/** Keep the first MAX_MISMATCH_EVIDENCE mismatches, then one summary entry with the dropped count. */
export function capMismatchEvidence(evidence: Evidence[], lockfile: string): Evidence[] {
  const out: Evidence[] = [];
  let mismatches = 0;
  for (const e of evidence) {
    if (e.kind === "lockfile-manifest-mismatch" && ++mismatches > MAX_MISMATCH_EVIDENCE) continue;
    out.push(e);
  }
  if (mismatches > MAX_MISMATCH_EVIDENCE) {
    out.push({
      kind: "lockfile-manifest-mismatch-summary",
      statement: `${mismatches - MAX_MISMATCH_EVIDENCE} more lockfile/manifest mismatches in ${lockfile} were not listed individually`,
      file: lockfile,
    });
  }
  return out;
}

type Format = "npm" | "pnpm" | "yarn" | "bun" | "bun-binary";
const LOCKFILES: [string, Format][] = [
  ["npm-shrinkwrap.json", "npm"],
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
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
  constraint: string;
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
      for (const [name, constraint] of Object.entries(map)) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, dev, constraint: String(constraint) });
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
    if (found.length === 0) {
      // bun.lockb is found by the same walk so members under a root bun.lockb report it.
      const binary = join(dir, "bun.lockb");
      if (await context.repository.exists(binary))
        return { path: binary, dir, format: "bun-binary" };
      continue;
    }
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

type TextFormat = Exclude<Format, "bun-binary">;

/** A lockfile read and parsed once per run, or the reason it could not be. */
type LoadResult =
  | { lockfile: LoadedLockfile; failure?: undefined }
  | { lockfile?: undefined; failure: { kind: string; statement: string } };

const LOADERS: Record<TextFormat, (text: string) => LoadedLockfile> = {
  npm: loadNpmLockfile,
  pnpm: loadPnpmLockfile,
  yarn: loadYarnLockfile,
  bun: loadBunLockfile,
};

function malformed(path: string, err: unknown): Evidence {
  return {
    kind: "lockfile-malformed",
    statement: `${path} could not be parsed (${err instanceof Error ? err.message.split("\n")[0] : "unknown error"})`,
    file: path,
  };
}

/** Recursively freeze parsed lockfile data so shared per-importer extraction cannot mutate it. */
function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const v of value.values()) deepFreeze(v, seen);
  } else {
    for (const v of Object.values(value)) deepFreeze(v, seen);
  }
  Object.freeze(value);
}

/**
 * Lockfiles parsed per analysis run, keyed by path (#170). A workspace root
 * lockfile is shared by every member project; re-parsing it per project made
 * large monorepos (vite: 273 projects, 510 KB pnpm-lock.yaml) spend ~35s in
 * YAML parsing and hit the adapter timeout.
 */
const loadCaches = new WeakMap<AdapterContext, Map<string, Promise<LoadResult>>>();

function loadLockfile(
  context: AdapterContext,
  path: string,
  format: TextFormat,
): Promise<LoadResult> {
  let cache = loadCaches.get(context);
  if (!cache) {
    cache = new Map();
    loadCaches.set(context, cache);
  }
  let pending = cache.get(path);
  if (!pending) {
    pending = (async (): Promise<LoadResult> => {
      let text: string;
      try {
        text = await context.repository.readFile(path);
      } catch {
        return { failure: { kind: "lockfile-unreadable", statement: `could not read ${path}` } };
      }
      if (Buffer.byteLength(text, "utf8") > MAX_LOCKFILE_BYTES) {
        return {
          failure: {
            kind: "lockfile-too-large",
            statement: `${path} exceeds ${MAX_LOCKFILE_BYTES} bytes and was not parsed`,
          },
        };
      }
      try {
        const lockfile = LOADERS[format](text);
        deepFreeze(lockfile);
        return { lockfile };
      } catch (err) {
        const { kind, statement } = malformed(path, err);
        return { failure: { kind, statement } };
      }
    })();
    cache.set(path, pending);
  }
  return pending;
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
  if (lock?.format === "bun-binary") {
    evidence.push({
      kind: "lockfile-unsupported",
      statement: `${lock.path} is Bun's binary lockfile, which is not parsed (the text bun.lock format is)`,
      file: lock.path,
    });
    return { graph: emptyGraph(project), evidence, lockfile: lock.path };
  }
  if (!lock) {
    evidence.push({
      kind: "lockfile-missing",
      statement: `no npm, pnpm, Yarn or Bun lockfile found for ${projectDir}; transitive graph unknown`,
    });
    return { graph: emptyGraph(project), evidence };
  }
  const loaded = await loadLockfile(context, lock.path, lock.format);
  if (loaded.failure) {
    evidence.push({ ...loaded.failure, file: lock.path });
    return { graph: emptyGraph(project), evidence, lockfile: lock.path };
  }
  const rel = relative(lock.dir, projectDir);
  let parsed: ParsedLockfile;
  try {
    const source = loaded.lockfile;
    parsed =
      lock.format === "npm"
        ? parseNpmLockfile(source, lock.path, rel === "." ? "" : rel, declared)
        : lock.format === "pnpm"
          ? parsePnpmLockfile(source, lock.path, rel, declared)
          : lock.format === "yarn"
            ? parseYarnLockfile(source, lock.path, rel, declared)
            : parseBunLockfile(source, lock.path, rel, declared);
  } catch (err) {
    evidence.push(malformed(lock.path, err));
    return { graph: emptyGraph(project), evidence, lockfile: lock.path };
  }
  evidence.push(...capMismatchEvidence(parsed.evidence, lock.path));
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
