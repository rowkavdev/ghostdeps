export { parseSpecifier } from "./specifier.js";
export type { ParsedSpecifier, SpecifierKind } from "./specifier.js";
export { scanSource, scriptKindFor, SCANNABLE_EXTENSIONS } from "./scan.js";
export type { FileScanResult, ImportReference } from "./scan.js";
export {
  findUsage,
  findRemovedUsages,
  scanForContext,
  scanRepository,
  usageLimitations,
  MAX_SOURCE_BYTES,
  MAX_UNRESOLVED_PER_FILE,
  MAX_OUTSIDE_PROJECT_RECORDS,
} from "./find-usage.js";
export type { RepositoryScan } from "./find-usage.js";
