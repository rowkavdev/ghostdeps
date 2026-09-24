/**
 * @ghostdeps/go - ecosystem adapter for Go modules. ADR 0002 is the contract.
 */
export { createGoAdapter } from "./adapter.js";
export { detectGo, GO_ECOSYSTEM, isIgnoredGoPath } from "./detect.js";
export { directDependencies, parseVendorModules, replacementFor } from "./manifest.js";
export { parseGoMod } from "./gomod.js";
export type {
  GoModExclude,
  GoModFile,
  GoModModule,
  GoModParseError,
  GoModReplace,
  GoModRequire,
  GoModRetract,
  GoModTool,
  GoModuleVersion,
} from "./gomod.js";
