import type { EcosystemAdapter } from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "@ghostdeps/javascript-typescript";
import { createRustAdapter } from "@ghostdeps/rust";

/** Adapters the CLI ships with. More ecosystems join as their adapters land. */
export function defaultAdapters(): EcosystemAdapter[] {
  return [createJavaScriptTypeScriptAdapter(), createRustAdapter()];
}
