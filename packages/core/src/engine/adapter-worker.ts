/**
 * Worker-thread entry for the isolated adapter tier (#90). One worker runs
 * one adapter through the exact runAdapter stage sequence the in-process
 * engine uses (run-adapter.ts - the logic must not fork).
 *
 * The adapter is loaded here by module specifier because functions cannot
 * cross the thread boundary: the module must export the adapter as its
 * default export or as a named `adapter` export. The repository handle is
 * rebuilt from the structured-cloned ScanResult; reads still re-check the
 * filesystem at read time (TOCTOU), so the worker needs no filesystem
 * trust beyond what the in-process tier has.
 *
 * Protocol (parentPort messages):
 *   { type: "loaded", ecosystem, apiVersion } - adapter resolved
 *   { type: "stage", stage }                  - stage boundary; resets the main-thread watchdog
 *   { type: "outcome", outcome }              - final AdapterOutcome (plain data)
 *   { type: "run-error", message }            - catastrophic failure before an outcome existed
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { EcosystemAdapter } from "../adapter.js";
import type { NetworkPolicy, SourceLineChanges } from "../types/index.js";
import { FsRepositoryHandle } from "./scanner/handle.js";
import type { ScanResult } from "./scanner/scanner.js";
import { runAdapter } from "./run-adapter.js";

export interface AdapterWorkerData {
  /** Module specifier the worker imports to obtain the adapter. */
  specifier: string;
  scan: ScanResult;
  network: NetworkPolicy;
  detectionThreshold: number;
  adapterTimeoutMs: number;
  usageConcurrency: number;
  /** PR mode (#101): bounded by the main thread before cloning. */
  pullRequestSourceChanges?: SourceLineChanges[];
}

function resolveAdapter(module: Record<string, unknown>, specifier: string): EcosystemAdapter {
  const candidate = (module.default ?? module.adapter) as EcosystemAdapter | undefined;
  if (
    candidate === undefined ||
    typeof candidate !== "object" ||
    typeof candidate.ecosystem !== "string" ||
    typeof candidate.detect !== "function" ||
    typeof candidate.listDirectDependencies !== "function"
  ) {
    throw new Error(
      `${specifier} does not export an EcosystemAdapter (expected a default or named "adapter" export)`,
    );
  }
  return candidate;
}

async function main(): Promise<void> {
  if (isMainThread || parentPort === null) throw new Error("adapter worker must run in a Worker");
  const port = parentPort;
  const data = workerData as AdapterWorkerData;
  const adapter = resolveAdapter(
    (await import(data.specifier)) as Record<string, unknown>,
    data.specifier,
  );
  port.postMessage({
    type: "loaded",
    ecosystem: adapter.ecosystem,
    apiVersion: adapter.apiVersion,
  });

  const repository = new FsRepositoryHandle(data.scan);
  const outcome = await runAdapter(
    adapter,
    repository,
    data.network,
    data.detectionThreshold,
    data.adapterTimeoutMs,
    data.usageConcurrency,
    (stage) => port.postMessage({ type: "stage", stage }),
    data.pullRequestSourceChanges,
  );
  port.postMessage({ type: "outcome", outcome });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  parentPort?.postMessage({ type: "run-error", message });
});
