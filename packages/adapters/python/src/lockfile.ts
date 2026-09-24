/**
 * uv.lock and poetry.lock graphs (issue #45). Lockfiles are the only source
 * of resolution (ADR 0004): no lockfile means an incomplete graph, never a
 * guess. Parsing is static TOML; nothing is installed or fetched.
 */
import { parse as parseToml } from "smol-toml";
import {
  MAX_LOCKFILE_BYTES,
  type AdapterContext,
  type DependencyGraph,
  type Evidence,
  type GraphNode,
  type ProjectRef,
} from "@ghostdeps/core";
import { parseManifests } from "./manifest.js";
import { normaliseName } from "./pep508.js";
import { joinPath } from "./paths.js";

/** One resolved package: normalised name, version, normalised edge names. */
export interface LockedPackage {
  name: string;
  version: string;
  dependencies: string[];
}

export interface ParsedPythonLockfile {
  packages: LockedPackage[];
  /** uv only: the project's own entry, whose edges are the direct dependencies. */
  root?: LockedPackage;
}

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function edgeNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(isTable)
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string")
    .map(normaliseName);
}

/**
 * uv.lock: [[package]] with `dependencies`, `optional-dependencies` and
 * `dev-dependencies` arrays of `{ name = ... }`. Optional and dev edges are
 * included: the closure answers "what could this pull in", and the graph's
 * dev flag is computed from reachability, not from these tables.
 */
export function parseUvLock(text: string, projectName?: string): ParsedPythonLockfile {
  const doc: unknown = parseToml(text);
  const packages: LockedPackage[] = [];
  let root: LockedPackage | undefined;
  const list = isTable(doc) && Array.isArray(doc.package) ? doc.package.filter(isTable) : [];
  for (const entry of list) {
    if (typeof entry.name !== "string") continue;
    const edges = new Set(edgeNames(entry.dependencies));
    for (const group of [entry["optional-dependencies"], entry["dev-dependencies"]]) {
      if (!isTable(group)) continue;
      for (const members of Object.values(group))
        for (const name of edgeNames(members)) edges.add(name);
    }
    const locked: LockedPackage = {
      name: normaliseName(entry.name),
      version: typeof entry.version === "string" ? entry.version : "0",
      dependencies: [...edges].sort(),
    };
    const source = isTable(entry.source) ? entry.source : {};
    const isProject =
      (projectName !== undefined && locked.name === normaliseName(projectName)) ||
      (projectName === undefined && (source.editable === "." || source.virtual === "."));
    if (isProject) root = locked;
    else packages.push(locked);
  }
  return root === undefined ? { packages } : { packages, root };
}

/** poetry.lock: [[package]] with a `dependencies` table of name -> constraint. */
export function parsePoetryLock(text: string): ParsedPythonLockfile {
  const doc: unknown = parseToml(text);
  const list = isTable(doc) && Array.isArray(doc.package) ? doc.package.filter(isTable) : [];
  const packages: LockedPackage[] = [];
  for (const entry of list) {
    if (typeof entry.name !== "string") continue;
    const deps = isTable(entry.dependencies) ? Object.keys(entry.dependencies) : [];
    packages.push({
      name: normaliseName(entry.name),
      version: typeof entry.version === "string" ? entry.version : "0",
      dependencies: [...new Set(deps.map(normaliseName))].filter((d) => d !== "python").sort(),
    });
  }
  return { packages };
}

/** Breadth-first closure over locked edges; unknown names are skipped. */
export function closureOf(start: string, byName: ReadonlyMap<string, LockedPackage>): string[] {
  const seen = new Set<string>();
  const queue = [...(byName.get(start)?.dependencies ?? [])];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name) || name === start) continue;
    seen.add(name);
    queue.push(...(byName.get(name)?.dependencies ?? []));
  }
  return [...seen].sort();
}

export interface PythonGraphResult {
  graph: DependencyGraph;
  evidence: Evidence[];
}

const LOCKFILES = [
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
] as const;

/** Nearest ancestor directory's lockfile, if any (the project's own is checked first). */
async function ancestorLockfile(
  context: AdapterContext,
  projectPath: string,
  name: string,
): Promise<string | undefined> {
  if (projectPath === ".") return undefined;
  const parts = projectPath.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = i === 0 ? name : `${parts.slice(0, i).join("/")}/${name}`;
    if (await context.repository.exists(candidate)) return candidate;
  }
  return undefined;
}

export async function buildProjectGraph(
  context: AdapterContext,
  project: ProjectRef,
): Promise<PythonGraphResult> {
  const { repository } = context;
  const evidence: Evidence[] = [];
  const manifests = await parseManifests(repository, project);
  const direct = manifests.requirements.map((r) => r.dependency);
  const empty = (): PythonGraphResult => ({
    graph: { project, nodes: [], transitiveClosure: {}, incomplete: true },
    evidence,
  });

  let parsed: ParsedPythonLockfile | undefined;
  let lockPath: string | undefined;
  for (const [name, kind] of LOCKFILES) {
    let path = joinPath(project.path, name);
    if (!(await repository.exists(path))) {
      // uv workspaces keep one uv.lock at the workspace root for every member.
      const inherited =
        kind === "uv" ? await ancestorLockfile(context, project.path, name) : undefined;
      if (inherited === undefined) continue;
      path = inherited;
      evidence.push({
        kind: "lockfile-inherited",
        statement: `${project.path} resolves through the workspace lockfile ${path}`,
        file: path,
      });
    }
    lockPath = path;
    let text: string;
    try {
      text = await repository.readFile(path);
    } catch {
      evidence.push({
        kind: "lockfile-unreadable",
        statement: `${path} could not be read`,
        file: path,
      });
      return empty();
    }
    if (Buffer.byteLength(text, "utf8") > MAX_LOCKFILE_BYTES) {
      evidence.push({
        kind: "lockfile-too-large",
        statement: `${path} exceeds ${MAX_LOCKFILE_BYTES} bytes and was not parsed`,
        file: path,
      });
      return empty();
    }
    try {
      parsed = kind === "uv" ? parseUvLock(text) : parsePoetryLock(text);
    } catch {
      evidence.push({
        kind: "lockfile-malformed",
        statement: `${path} is not valid TOML; the graph is incomplete`,
        file: path,
      });
      return empty();
    }
    break;
  }
  if (parsed === undefined) {
    evidence.push({
      kind: "lockfile-missing",
      statement: `no uv.lock or poetry.lock at ${project.path}; transitive dependencies are not resolved`,
    });
    return empty();
  }

  const byName = new Map(parsed.packages.map((p) => [p.name, p]));
  const runtimeDirect = direct.filter((d) => d.kind !== "dev").map((d) => d.name);
  const runtimeReach = new Set<string>(runtimeDirect);
  for (const name of runtimeDirect)
    for (const dep of closureOf(name, byName)) runtimeReach.add(dep);

  const nodes: GraphNode[] = parsed.packages.map((p) => ({
    name: p.name,
    version: p.version,
    dependencies: p.dependencies,
    dev: !runtimeReach.has(p.name),
  }));
  const transitiveClosure: Record<string, string[]> = {};
  let missing = 0;
  for (const dep of direct) {
    if (!byName.has(dep.name)) {
      missing++;
      continue;
    }
    transitiveClosure[dep.name] = closureOf(dep.name, byName);
  }
  if (missing > 0 && lockPath !== undefined) {
    evidence.push({
      kind: "lockfile-mismatch",
      statement: `${missing} declared dependenc${missing === 1 ? "y is" : "ies are"} missing from ${lockPath}; the lockfile may be stale`,
      file: lockPath,
    });
  }
  return { graph: { project, nodes, transitiveClosure, incomplete: missing > 0 }, evidence };
}

export async function buildDependencyGraph(
  context: AdapterContext,
  projects: ProjectRef[],
): Promise<DependencyGraph[]> {
  const graphs: DependencyGraph[] = [];
  for (const project of projects) graphs.push((await buildProjectGraph(context, project)).graph);
  return graphs;
}
