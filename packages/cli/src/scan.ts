import {
  analyseRepository,
  FsRepositoryHandle,
  type AnalysisResult,
  type EcosystemAdapter,
} from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "@ghostdeps/javascript-typescript";
import type { CliConfig } from "./config.js";
import type { Io } from "./cli.js";
import { EXIT_OK, NotImplementedError } from "./errors.js";
import { printJson } from "./output/json.js";

/** Adapters the CLI ships with. More ecosystems join as their adapters land. */
export function defaultAdapters(): EcosystemAdapter[] {
  return [createJavaScriptTypeScriptAdapter()];
}

/**
 * Analyse a local directory. Static and offline: the scanner reads files
 * through an inert FsRepositoryHandle and nothing in the repository runs.
 */
export async function analysePath(path: string): Promise<AnalysisResult> {
  const repository = await FsRepositoryHandle.open(path);
  return analyseRepository(repository, {
    adapters: defaultAdapters(),
    network: { mode: "offline" },
  });
}

/** `ghostdeps scan [path]`. --json prints the schema-stable AnalysisResult. */
export async function runScan(config: CliConfig, io: Io): Promise<number> {
  if (!config.json) {
    // Human output lands with the repository-summary renderer (#39/#109).
    throw new NotImplementedError("ghostdeps scan is not implemented yet");
  }
  printJson(await analysePath(config.path), io);
  return EXIT_OK;
}
