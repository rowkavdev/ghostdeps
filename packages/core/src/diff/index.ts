export {
  addedLines,
  defaultDiffParseLimits,
  removedLines,
  parseUnifiedDiff,
  type DiffHunk,
  type DiffLine,
  type DiffParseLimits,
  type FileChangeStatus,
  type FileDiff,
  type ParsedDiff,
} from "./unified.js";
export {
  classifyDependencyFile,
  type DependencyFileMatch,
  type DependencyFileRole,
} from "./dependency-files.js";
export {
  diffDeclaredDependencies,
  extractDependencyChanges,
  isSafeRepositoryPath,
  type ChangedLockfile,
  type ChangedSourceFile,
  type DeclaredVersion,
  type DependencyChange,
  type DiffSide,
  type PullRequestDependencyChanges,
  type ReadDeclaredDependencies,
} from "./dependency-changes.js";
export { reconstructBase } from "./reconstruct-base.js";
