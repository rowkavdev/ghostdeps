/**
 * Same-ecosystem duplicate capability detection (#58, slice 1):
 * declaration tier only. When two or more packages in one capability
 * cluster are declared in the same project, each gets one finding naming
 * the others - "review whether multiple X are necessary", never an
 * auto-remove claim (#58's goal).
 *
 * Slice 1 is declaration evidence only: the catalogue says the packages
 * cover the same capability, but usage was not compared, so every finding
 * is low confidence with that limitation stated. The usage-evidenced tier
 * (one package's observed API use covered by another) is slice 2 and
 * builds on #56's rule contract. Wiring into the pipeline (policy config,
 * PR-mode semantics, awareness) is deferred to the same ruling - this
 * module is exported and tested but not called by analyse.ts yet.
 *
 * Cross-ecosystem overlap is #55's job (capability-overlap.ts); this
 * detector stays within one project root and one ecosystem. The same
 * package in two workspace projects of one ecosystem is normal monorepo
 * structure, not a duplicate.
 */
import {
  CAPABILITY_CATALOGUE,
  catalogueName,
  type CapabilityCatalogue,
} from "../capabilities/index.js";
import type { Dependency, Finding } from "../types/index.js";

export const SAME_ECOSYSTEM_DUPLICATES_RULE = "same-ecosystem-capability-duplicates";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Peer and optional declarations are constraints, not installs, and
 * non-registry specifiers (workspace/link/file/git) are not removal
 * candidates - the same preconditions the no-imports policy rules use.
 */
function isCandidate(d: Dependency): boolean {
  if (d.kind === "peer" || d.kind === "optional") return false;
  if (d.specifier && d.specifier.type !== "registry") return false;
  return true;
}

/** Declaration location for evidence: file, plus line when the adapter found it. */
const atDeclaration = (d: Dependency): { file: string; line?: number } =>
  d.declaredLine === undefined
    ? { file: d.declaredIn }
    : { file: d.declaredIn, line: d.declaredLine };

/**
 * One finding per declared member of every cluster with two or more
 * members in the same project. Deterministic output: projects, clusters
 * and members are visited in sorted order, and each finding's evidence is
 * emitted in a fixed order.
 */
export function sameEcosystemDuplicates(
  dependencies: readonly Dependency[],
  catalogue: CapabilityCatalogue = CAPABILITY_CATALOGUE,
): Finding[] {
  // projectKey -> clusterId -> declared name -> declarations
  const byProject = new Map<string, Map<string, Map<string, Dependency[]>>>();
  for (const dep of dependencies) {
    if (!isCandidate(dep)) continue;
    const projectKey = `${dep.project.path}\0${dep.project.ecosystem}`;
    for (const cluster of catalogue.clusters) {
      const hit = cluster.members.some(
        (mem) =>
          mem.ecosystem === dep.project.ecosystem &&
          catalogueName(mem.ecosystem, mem.name) === catalogueName(dep.project.ecosystem, dep.name),
      );
      if (!hit) continue;
      if (!byProject.has(projectKey)) byProject.set(projectKey, new Map());
      const clusters = byProject.get(projectKey)!;
      if (!clusters.has(cluster.id)) clusters.set(cluster.id, new Map());
      const names = clusters.get(cluster.id)!;
      if (!names.has(dep.name)) names.set(dep.name, []);
      names.get(dep.name)!.push(dep);
    }
  }

  const findings: Finding[] = [];
  for (const [projectKey, clusters] of [...byProject.entries()].sort(([a], [b]) => compare(a, b))) {
    for (const [clusterId, names] of [...clusters.entries()].sort(([a], [b]) => compare(a, b))) {
      if (names.size < 2) continue;
      const cluster = catalogue.clusters.find((c) => c.id === clusterId)!;
      const projectPath = projectKey.slice(0, projectKey.indexOf("\0"));
      const place = projectPath === "." ? "the project root" : projectPath;
      const declaredNames = [...names.keys()].sort(compare);
      for (const name of declaredNames) {
        const declarations = names
          .get(name)!
          .slice()
          .sort((a, b) => compare(a.declaredIn, b.declaredIn));
        const others = declaredNames.filter((n) => n !== name);
        findings.push({
          kind: "duplicate-capability",
          rule: SAME_ECOSYSTEM_DUPLICATES_RULE,
          dependency: name,
          summary: `${name} and ${others.join(", ")} all provide ${cluster.label} in ${place}`,
          recommendation:
            `Review whether ${declaredNames.join(", ")} are all necessary. ` +
            `This is declaration evidence only - check how each is used before removing any of them.`,
          evidence: [
            {
              kind: "capability-cluster",
              statement: `${declaredNames.join(", ")} are listed under "${cluster.id}" in the capability catalogue (version ${catalogue.version})`,
            },
            ...declarations.map((d) => ({
              kind: "declared-in",
              statement: `${d.name} is declared as a ${d.kind} dependency in ${d.declaredIn}`,
              ...atDeclaration(d),
            })),
          ],
          confidence: "low",
          limitations: [
            "Based on declared dependencies and the capability catalogue, not on how each package is used.",
            "Distinct API use or different versions can make more than one package necessary.",
          ],
          affectedFiles: declarations.map((d) => d.declaredIn),
        });
      }
    }
  }
  return findings;
}
