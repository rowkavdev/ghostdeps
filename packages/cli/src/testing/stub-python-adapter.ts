/**
 * TEST-ONLY stub Python adapter (#55 slice 4). It exists so the polyglot
 * fixture can prove multi-ecosystem mechanics before a real Python adapter
 * exists. It is not Python support: it reads the `[project] dependencies`
 * list of each pyproject.toml with a simple pattern and a plain
 * `name==version` requirements.lock next to it. It does no usage analysis.
 * Never ship it: defaultAdapters() must not include it, and the real
 * adapter belongs in packages/adapters.
 */
import {
  adapterApiVersion,
  type AdapterCapability,
  type AdapterContext,
  type Dependency,
  type DependencyGraph,
  type DetectionResult,
  type EcosystemAdapter,
  type ProjectRef,
} from "@ghostdeps/core";

const ECOSYSTEM = "python";

const dirOf = (file: string): string => {
  const i = file.lastIndexOf("/");
  return i < 0 ? "." : file.slice(0, i);
};
const inDir = (dir: string, name: string): string => (dir === "." ? name : `${dir}/${name}`);

function projectDependencies(pyproject: string): { name: string; constraint: string }[] {
  const block = /^dependencies\s*=\s*\[([^\]]*)\]/m.exec(pyproject)?.[1] ?? "";
  return [...block.matchAll(/"([A-Za-z0-9][A-Za-z0-9._-]*)\s*([^"]*)"/g)].map((m) => ({
    name: m[1]!,
    constraint: m[2]!.trim(),
  }));
}

/** Marks the stub so a test can prove it never reaches defaultAdapters(). */
export const TEST_ONLY_STUB = Symbol("ghostdeps.test-only-stub");

export function isTestOnlyStub(adapter: EcosystemAdapter): boolean {
  return TEST_ONLY_STUB in adapter;
}

export function createStubPythonAdapter(): EcosystemAdapter & { [TEST_ONLY_STUB]: true } {
  const capabilities: ReadonlySet<AdapterCapability> = new Set([
    "dependencyGraph",
    "lockfileParsing",
  ]);
  return {
    [TEST_ONLY_STUB]: true,
    ecosystem: ECOSYSTEM,
    capabilities,
    apiVersion: adapterApiVersion,

    async detect(context: AdapterContext): Promise<DetectionResult> {
      const manifests = (await context.repository.listFiles())
        .filter((f) => f === "pyproject.toml" || f.endsWith("/pyproject.toml"))
        .sort();
      return {
        confidence: manifests.length > 0 ? 0.9 : 0,
        projects: manifests.map((f) => ({
          path: dirOf(f),
          ecosystem: ECOSYSTEM,
          packageManagers: [],
        })),
        evidence: manifests.map((f) => ({ kind: "manifest", statement: `found ${f}`, file: f })),
      };
    },

    async listDirectDependencies(
      context: AdapterContext,
      projects: ProjectRef[],
    ): Promise<Dependency[]> {
      const deps: Dependency[] = [];
      for (const project of projects) {
        const file = inDir(project.path, "pyproject.toml");
        for (const d of projectDependencies(await context.repository.readFile(file))) {
          deps.push({
            name: d.name,
            constraint: d.constraint,
            kind: "runtime",
            project,
            declaredIn: file,
          });
        }
      }
      return deps;
    },

    async buildDependencyGraph(
      context: AdapterContext,
      projects: ProjectRef[],
    ): Promise<DependencyGraph[]> {
      const files = new Set(await context.repository.listFiles());
      const graphs: DependencyGraph[] = [];
      for (const project of projects) {
        const lock = inDir(project.path, "requirements.lock");
        if (!files.has(lock)) {
          graphs.push({ project, nodes: [], transitiveClosure: {}, incomplete: true });
          continue;
        }
        const nodes = (await context.repository.readFile(lock))
          .split("\n")
          .map((line) => /^([A-Za-z0-9._-]+)==(\S+)/.exec(line.trim()))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => ({ name: m[1]!, version: m[2]!, dependencies: [], dev: false }));
        graphs.push({ project, nodes, transitiveClosure: {}, incomplete: false });
      }
      return graphs;
    },
  };
}
