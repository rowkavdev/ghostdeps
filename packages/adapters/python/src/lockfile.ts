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
  /**
   * uv only: workspace members and other local projects (editable or
   * virtual sources). They are first-party code, never graph nodes.
   */
  members?: ReadonlySet<string>;
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
  const members = new Set<string>();
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
    if (typeof source.editable === "string" || typeof source.virtual === "string") {
      members.add(locked.name);
    }
    if (isProject) root = locked;
    else packages.push(locked);
  }
  return root === undefined ? { packages, members } : { packages, root, members };
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

  // Traversal walks through workspace members (their dependencies are
  // pulled in), but members themselves are first-party and never become
  // nodes or closure entries. Nodes are limited to what this project's own
  // direct dependencies reach: a workspace lockfile covers every member.
  const byName = new Map(parsed.packages.map((p) => [p.name, p]));
  const members = new Set(parsed.members ?? []);
  if (parsed.root !== undefined) members.add(parsed.root.name);
  const thirdParty = (names: Iterable<string>): string[] =>
    [...names].filter((name) => !members.has(name));
  const reachFrom = (names: readonly string[]): Set<string> => {
    const reach = new Set<string>(names);
    for (const name of names) for (const dep of closureOf(name, byName)) reach.add(dep);
    return reach;
  };
  const runtimeReach = reachFrom(direct.filter((d) => d.kind !== "dev").map((d) => d.name));
  const allReach = reachFrom(direct.map((d) => d.name));

  const nodes: GraphNode[] = parsed.packages
    .filter((p) => allReach.has(p.name) && !members.has(p.name))
    .map((p) => ({
      name: p.name,
      version: p.version,
      dependencies: thirdParty(p.dependencies),
      dev: !runtimeReach.has(p.name),
    }));
  const transitiveClosure: Record<string, string[]> = {};
  const missingNames: string[] = [];
  for (const dep of direct) {
    if (!byName.has(dep.name)) {
      missingNames.push(dep.name);
      continue;
    }
    transitiveClosure[dep.name] = thirdParty(closureOf(dep.name, byName));
  }
  const missing = missingNames.length;
  if (missing > 0 && lockPath !== undefined) {
    evidence.push({
      kind: "lockfile-mismatch",
      statement: `${missing} declared dependenc${missing === 1 ? "y is" : "ies are"} missing from ${lockPath} (${missingNames.join(", ")}); the lockfile may be stale`,
      file: lockPath,
    });
  }
  return { graph: { project, nodes, transitiveClosure, incomplete: missing > 0 }, evidence };
}

export interface PythonLockAnalysis {
  graphs: DependencyGraph[];
  /** Why each incomplete graph is incomplete (and inherited-lockfile notes). */
  evidence: Evidence[];
}

/**
 * Graphs plus the lockfile evidence behind them. DependencyGraph has no
 * evidence field, so detection carries this evidence (same approach as the
 * rust adapter, #225/#228).
 */
export async function analysePythonLocks(
  context: AdapterContext,
  projects: ProjectRef[],
): Promise<PythonLockAnalysis> {
  const graphs: DependencyGraph[] = [];
  const evidence: Evidence[] = [];
  for (const project of projects) {
    const result = await buildProjectGraph(context, project);
    graphs.push(result.graph);
    evidence.push(...result.evidence);
  }
  return { graphs, evidence };
}

export async function buildDependencyGraph(
  context: AdapterContext,
  projects: ProjectRef[],
): Promise<DependencyGraph[]> {
  return (await analysePythonLocks(context, projects)).graphs;
}
