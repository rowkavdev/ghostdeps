import {
  CAPABILITY_CATALOGUE,
  catalogueName,
  type CapabilityCatalogue,
} from "../capabilities/index.js";
import type { DependencyChange } from "../diff/dependency-changes.js";
import type { Dependency, Finding } from "../types/index.js";

export const CROSS_ECOSYSTEM_OVERLAP_RULE = "cross-ecosystem-capability-overlap";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Cross-ecosystem capability overlap (#55): when a catalogue capability is
 * declared in two or more ecosystems (say axios in a JS app and requests
 * in a Python service), each declared package gets one info finding naming
 * the packages that cover the same capability in the other ecosystems.
 *
 * Information only, never a verdict: packages in different ecosystems
 * can't replace each other. Every finding carries its dependency, so it is
 * never a run note. Same-ecosystem duplicates are #58's job.
 *
 * In a pull request, pass the PR's dependency changes: only packages the
 * PR added are reported, so an existing overlap doesn't show on every PR.
 */
export function crossEcosystemOverlaps(
  dependencies: readonly Dependency[],
  pullRequestChanges?: readonly DependencyChange[],
  catalogue: CapabilityCatalogue = CAPABILITY_CATALOGUE,
): Finding[] {
  const added = pullRequestChanges
    ? new Set(
        pullRequestChanges
          .filter((c) => c.change === "added")
          .map((c) => `${c.ecosystem}\0${c.name}`),
      )
    : undefined;
  const findings: Finding[] = [];
  for (const cluster of catalogue.clusters) {
    const members = new Set(
      cluster.members.map((mem) => `${mem.ecosystem}\0${catalogueName(mem.ecosystem, mem.name)}`),
    );
    // ecosystem -> declared name -> manifests declaring it
    const found = new Map<string, Map<string, Set<string>>>();
    for (const dep of dependencies) {
      const eco = dep.project.ecosystem;
      if (!members.has(`${eco}\0${catalogueName(eco, dep.name)}`)) continue;
      if (!found.has(eco)) found.set(eco, new Map());
      const names = found.get(eco)!;
      if (!names.has(dep.name)) names.set(dep.name, new Set());
      names.get(dep.name)!.add(dep.declaredIn);
    }
    if (found.size < 2) continue;

    const ecosystems = [...found.keys()].sort(compare);
    for (const eco of ecosystems) {
      const others = ecosystems
        .filter((e) => e !== eco)
        .map((e) => `${[...found.get(e)!.keys()].sort(compare).join(", ")} (${e})`);
      for (const [name, manifests] of [...found.get(eco)!].sort(([a], [b]) => compare(a, b))) {
        if (added && !added.has(`${eco}\0${name}`)) continue;
        findings.push({
          kind: "info",
          rule: CROSS_ECOSYSTEM_OVERLAP_RULE,
          dependency: name,
          summary: `${name} (${eco}) covers the same capability (${cluster.label}) as ${others.join("; ")}`,
          recommendation:
            "For awareness only. Packages in different ecosystems can't replace each other; no change is suggested.",
          evidence: [
            {
              kind: "capability-cluster",
              statement: `${name} and ${others.join("; ")} are listed under "${cluster.id}" in the capability catalogue (version ${catalogue.version})`,
            },
          ],
          confidence: "high",
          limitations: [
            "Based on declared dependencies and the catalogue, not on how each package is used.",
          ],
          affectedFiles: [...manifests].sort(compare),
        });
      }
    }
  }
  return findings;
}
