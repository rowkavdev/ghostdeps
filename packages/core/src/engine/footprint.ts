import type {
  DependencyFootprint,
  DependencyGraph,
  DependencyImpact,
  PackageMetadataProvider,
  PackageVersionRef,
} from "../types/index.js";

/** Most distinct package versions asked for per ecosystem; past it, no footprint there. */
export const MAX_FOOTPRINT_PACKAGES = 50_000;
/** Wall-clock budget for one provider call; past it, no footprint for that ecosystem. */
export const FOOTPRINT_TIMEOUT_MS = 10_000;
const MAX_BASIS_LENGTH = 100;

const projectKey = (ecosystem: string, path: string): string => `${ecosystem}\0${path}`;
const versionKey = (name: string, version: string): string => `${name}\0${version}`;

/**
 * Add approximate install footprints to impact entries (#59 slice B). Sizes
 * come only from the caller's cached provider; with none, or when it fails,
 * times out or knows nothing, entries are returned unchanged. Only entries
 * with a known closure (`transitive` not null) get one. Never throws.
 */
export async function addFootprints(
  impact: readonly DependencyImpact[],
  graphs: readonly DependencyGraph[],
  provider: PackageMetadataProvider | undefined,
  timeoutMs: number = FOOTPRINT_TIMEOUT_MS,
): Promise<DependencyImpact[]> {
  if (!provider || typeof provider.installSizes !== "function") return [...impact];

  const graphsByProject = new Map<string, DependencyGraph[]>();
  for (const graph of graphs) {
    if (graph.incomplete && graph.nodes.length === 0) continue;
    const key = projectKey(graph.project.ecosystem, graph.project.path);
    const list = graphsByProject.get(key);
    if (list) list.push(graph);
    else graphsByProject.set(key, [graph]);
  }

  // Per entry, the package versions locked for itself and each closure
  // member (closures are by name, so every locked version of a name).
  const members = new Map<DependencyImpact, Map<string, PackageVersionRef>>();
  const wanted = new Map<string, Map<string, PackageVersionRef>>();
  for (const entry of impact) {
    if (entry.transitive === null) continue;
    const projectGraphs = graphsByProject.get(projectKey(entry.ecosystem, entry.project)) ?? [];
    const set = new Map<string, PackageVersionRef>();
    for (const graph of projectGraphs) {
      const closure = Object.hasOwn(graph.transitiveClosure, entry.name)
        ? graph.transitiveClosure[entry.name]
        : undefined;
      if (!Array.isArray(closure)) continue;
      const names = new Set<string>([entry.name]);
      for (const member of closure) if (typeof member === "string") names.add(member);
      for (const node of graph.nodes) {
        if (typeof node.name !== "string" || typeof node.version !== "string") continue;
        if (!names.has(node.name) || node.version === "") continue;
        set.set(versionKey(node.name, node.version), { name: node.name, version: node.version });
      }
    }
    if (set.size === 0) continue;
    members.set(entry, set);
    let perEcosystem = wanted.get(entry.ecosystem);
    if (!perEcosystem) wanted.set(entry.ecosystem, (perEcosystem = new Map()));
    for (const [key, ref] of set) perEcosystem.set(key, ref);
  }

  const answers = new Map<string, { basis: string; sizes: Map<string, number> }>();
  for (const ecosystem of [...wanted.keys()].sort()) {
    const refs = [...wanted.get(ecosystem)!.values()];
    if (refs.length > MAX_FOOTPRINT_PACKAGES) continue;
    refs.sort((a, b) => versionKey(a.name, a.version).localeCompare(versionKey(b.name, b.version)));
    const answer = await askProvider(provider, ecosystem, refs, timeoutMs);
    if (answer) answers.set(ecosystem, answer);
  }

  return impact.map((entry) => {
    const set = members.get(entry);
    const answer = answers.get(entry.ecosystem);
    if (!set || !answer) return entry;
    // A lower bound (#288): each name installs at least one of its locked
    // versions, but which one isn't known from name-keyed closures. So a
    // name counts only when every locked version of it is sized, and at
    // its smallest.
    const byName = new Map<string, number | undefined>();
    for (const [key, ref] of set) {
      const size = answer.sizes.get(key);
      if (!byName.has(ref.name)) byName.set(ref.name, size);
      else {
        const prev = byName.get(ref.name);
        byName.set(
          ref.name,
          prev === undefined || size === undefined ? undefined : Math.min(prev, size),
        );
      }
    }
    let sized = 0;
    let bytes = 0;
    for (const size of byName.values()) {
      if (size === undefined) continue;
      sized++;
      bytes += size;
    }
    if (sized === 0) return entry;
    const footprint: DependencyFootprint = {
      approximate: true,
      basis: answer.basis,
      bytes,
      coverage: { sized, total: byName.size },
    };
    return { ...entry, footprint };
  });
}

/** One bounded, validated provider call. Undefined on any failure. */
async function askProvider(
  provider: PackageMetadataProvider,
  ecosystem: string,
  packages: PackageVersionRef[],
  timeoutMs: number,
): Promise<{ basis: string; sizes: Map<string, number> } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const raw: unknown = await Promise.race([
      Promise.resolve().then(() => provider.installSizes({ ecosystem, packages })),
      timeout,
    ]);
    if (!raw || typeof raw !== "object") return undefined;
    const { basis, sizes } = raw as { basis?: unknown; sizes?: unknown };
    if (typeof basis !== "string" || basis.trim() === "" || !Array.isArray(sizes)) return undefined;
    const asked = new Set(packages.map((p) => versionKey(p.name, p.version)));
    const out = new Map<string, number>();
    for (const item of sizes) {
      if (!item || typeof item !== "object") continue;
      const { name, version, bytes } = item as {
        name?: unknown;
        version?: unknown;
        bytes?: unknown;
      };
      if (typeof name !== "string" || typeof version !== "string") continue;
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) continue;
      const key = versionKey(name, version);
      // Only what was asked for, first answer wins.
      if (asked.has(key) && !out.has(key)) out.set(key, bytes);
    }
    if (out.size === 0) return undefined;
    return { basis: basis.trim().slice(0, MAX_BASIS_LENGTH), sizes: out };
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
