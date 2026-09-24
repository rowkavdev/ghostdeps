/**
 * @ghostdeps/go - ecosystem adapter for Go modules. ADR 0002 is the contract.
 */
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
