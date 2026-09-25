/** Source-backed health observations for exact locked direct dependencies (#61).
 * The caller's metadata provider owns all network I/O. Missing or invalid
 * metadata is silence, never an inferred health verdict.
 */
import type {
  Dependency,
  DependencyGraph,
  Finding,
  MetadataFact,
  PackageMetadataProvider,
  PackageRegistryFacts,
  PackageVersionRef,
} from "../types/index.js";
import { normaliseRegistryOrigin } from "../registry-origins.js";

export const HEALTH_TIMEOUT_MS = 10_000;
export const MAX_HEALTH_PACKAGES = 50_000;
const key = (name: string, version: string): string => `${name}\0${version}`;
const projectKey = (ecosystem: string, path: string): string => `${ecosystem}\0${path}`;

function basis<T>(fact: MetadataFact<T> | undefined): string | undefined {
  return typeof fact?.basis === "string" && fact.basis.trim() && fact.basis.length <= 200
    ? fact.basis.trim()
    : undefined;
}

/** Only explicitly true signals. false and absent facts say nothing about risk. */
function signals(name: string, facts: PackageRegistryFacts): Finding[] {
  const result: Finding[] = [];
  const add = (rule: string, summary: string, source: string): void => {
    result.push({
      kind: "info",
      rule,
      dependency: name,
      summary,
      recommendation: "Review the source-backed status before changing this dependency.",
      evidence: [{ kind: rule, statement: `${summary} (source: ${source})` }],
      confidence: "high",
      limitations: [],
      affectedFiles: [],
    });
  };
  const deprecatedSource = basis(facts.deprecated);
  if (facts.deprecated?.value === true && deprecatedSource)
    add("registry-deprecated", `${name} is marked deprecated`, deprecatedSource);
  const archivedSource = basis(facts.repositoryArchived);
  if (facts.repositoryArchived?.value === true && archivedSource)
    add("repository-archived", `${name}'s repository is archived`, archivedSource);
  // publishedAt names only the locked version, never project staleness.
  const publishedSource = basis(facts.publishedAt);
  const date = facts.publishedAt?.value;
  if (
    publishedSource &&
    typeof date === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(date) &&
    Number.isFinite(Date.parse(date))
  ) {
    add(
      "locked-version-published",
      `${name} locked version ${facts.version} published ${date}`,
      publishedSource,
    );
  }
  // No "last release", "newer available", or cadence from this field.
  // latestVersion needs its own source before newer-available framing.
  return result;
}

export async function healthFindings(
  dependencies: readonly Dependency[],
  graphs: readonly DependencyGraph[],
  provider: PackageMetadataProvider | undefined,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<Finding[]> {
  if (!provider || typeof provider.packageFacts !== "function") return [];
  const graphsByProject = new Map<string, DependencyGraph[]>();
  for (const graph of graphs) {
    const id = projectKey(graph.project.ecosystem, graph.project.path);
    const list = graphsByProject.get(id) ?? [];
    list.push(graph);
    graphsByProject.set(id, list);
  }
  const requested = new Map<string, Map<string, PackageVersionRef>>();
  const targets: { name: string; ecosystem: string; version: string; origin: string }[] = [];
  for (const dep of dependencies) {
    if (dep.specifier && dep.specifier.type !== "registry") continue;
    // Only a single unambiguous public-registry origin and locked version.
    const nodes = (graphsByProject.get(projectKey(dep.project.ecosystem, dep.project.path)) ?? [])
      .flatMap((graph) => graph.nodes)
      .filter((node) => node.name === dep.name);
    if (!nodes.length) continue;
    const refs = nodes.map((node) => ({
      version: node.version,
      origin: normaliseRegistryOrigin(node.registryOrigin),
    }));
    if (refs.some((ref) => !ref.version || !ref.origin)) continue;
    const distinct = new Set(refs.map((ref) => `${ref.version}\0${ref.origin}`));
    if (distinct.size !== 1) continue;
    const { version, origin } = refs[0]!;
    const ecosystem = dep.project.ecosystem;
    const byVersion = requested.get(ecosystem) ?? new Map<string, PackageVersionRef>();
    byVersion.set(key(dep.name, version), { name: dep.name, version, origin: origin! });
    requested.set(ecosystem, byVersion);
    targets.push({ name: dep.name, ecosystem, version, origin: origin! });
  }
  const answers = new Map<string, Map<string, PackageRegistryFacts>>();
  for (const ecosystem of [...requested.keys()].sort()) {
    const refs = [...requested.get(ecosystem)!.values()].sort((a, b) =>
      key(a.name, a.version).localeCompare(key(b.name, b.version)),
    );
    if (refs.length > MAX_HEALTH_PACKAGES) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw: unknown = await Promise.race([
        Promise.resolve().then(() => provider.packageFacts!({ ecosystem, packages: refs })),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
      if (!Array.isArray(raw)) continue;
      const asked = requested.get(ecosystem)!;
      const found = new Map<string, PackageRegistryFacts>();
      const conflicting = new Set<string>();
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const fact = item as PackageRegistryFacts;
        if (typeof fact.name !== "string" || typeof fact.version !== "string") continue;
        const ref = asked.get(key(fact.name, fact.version));
        if (!ref || normaliseRegistryOrigin(fact.origin) !== ref.origin) continue;
        // Conflicting duplicate answers cannot support a claim.
        const id = key(fact.name, fact.version);
        if (found.has(id)) {
          found.delete(id);
          conflicting.add(id);
        } else if (!conflicting.has(id)) {
          found.set(id, fact);
        }
      }
      answers.set(ecosystem, found);
    } catch {
      // Offline, failure or malformed metadata must not affect analysis.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return targets.flatMap(({ name, ecosystem, version, origin }) => {
    const fact = answers.get(ecosystem)?.get(key(name, version));
    return fact && normaliseRegistryOrigin(fact.origin) === origin ? signals(name, fact) : [];
  });
}
