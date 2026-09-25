/**
 * Registry metadata routing. Adapters are registered per ecosystem, never
 * inferred from package names. Each adapter owns its public-origin policy and
 * fetch implementation; an unknown ecosystem has no network access.
 */
import {
  normaliseRegistryOrigin,
  type PackageMetadataProvider,
  type PackageRegistryFacts,
  type PackageVersionRef,
} from "@ghostdeps/core";
import { NPM_ECOSYSTEM, NpmMetadataService, type RunMetadataProvider } from "./npm-metadata.js";

type Request = { ecosystem: string; packages: readonly PackageVersionRef[] };
export interface EcosystemMetadataFetcher {
  /** Explicit trusted origins for this ecosystem; no wildcard matching. */
  readonly publicOrigins: readonly string[];
  forRun(): RunMetadataProvider;
}

/** One service owns caches; every analysis takes a fresh budget via forRun(). */
export class RegistryMetadataService {
  readonly #providers: ReadonlyMap<string, EcosystemMetadataFetcher>;
  constructor(
    providers: ReadonlyMap<string, EcosystemMetadataFetcher> = new Map([
      [NPM_ECOSYSTEM, new NpmMetadataService()],
    ]),
  ) {
    this.#providers = new Map(providers);
  }

  forRun(): RunMetadataProvider {
    const runs = new Map<string, RunMetadataProvider>();
    const provider = (ecosystem: string) => {
      const configured = this.#providers.get(ecosystem);
      if (!configured || configured.publicOrigins.length === 0) return undefined;
      let run = runs.get(ecosystem);
      if (!run) {
        run = configured.forRun();
        runs.set(ecosystem, run);
      }
      return run;
    };
    const providers = this.#providers;
    return {
      get complete() {
        return [...runs.values()].every((run) => run.complete);
      },
      async installSizes(request: Request) {
        try {
          const configured = providers.get(request.ecosystem);
          if (!configured || !Array.isArray(request.packages)) return undefined;
          const packages = request.packages.filter((ref) => {
            const origin = normaliseRegistryOrigin(ref?.origin);
            return origin !== undefined && configured.publicOrigins.includes(origin);
          });
          return await provider(request.ecosystem)?.installSizes({ ...request, packages });
        } catch {
          return undefined;
        }
      },
      async packageFacts(request: Request): Promise<readonly PackageRegistryFacts[] | undefined> {
        try {
          const configured = providers.get(request.ecosystem);
          if (!configured || !Array.isArray(request.packages)) return undefined;
          const packages = request.packages.filter((ref) => {
            const origin = normaliseRegistryOrigin(ref?.origin);
            return origin !== undefined && configured.publicOrigins.includes(origin);
          });
          return await provider(request.ecosystem)?.packageFacts?.({ ...request, packages });
        } catch {
          return undefined;
        }
      },
    } satisfies RunMetadataProvider & PackageMetadataProvider;
  }
}
