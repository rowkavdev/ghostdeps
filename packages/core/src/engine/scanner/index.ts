export { DEFAULT_SCAN_LIMITS, resolveLimits, type ScanLimits } from "./limits.js";
export {
  DEFAULT_EXCLUDED_DIRECTORIES,
  DEFAULT_EXCLUDED_FILE_SUFFIXES,
  LOCKFILE_NAMES,
  PROJECT_MANIFESTS,
} from "./exclusions.js";
export {
  scanRepository,
  type CandidateProjectRoot,
  type ScanOptions,
  type ScanResult,
  type ScannedFile,
  type SkipReason,
  type SkippedEntry,
  type TruncationReason,
} from "./scanner.js";
export { FsRepositoryHandle, RepositoryReadError, type RepositoryReadErrorCode } from "./handle.js";
export { fixtureScope, readFixtureRoots, type ScanScope, type FixtureRootCount } from "./scope.js";
