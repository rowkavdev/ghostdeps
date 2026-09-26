import type { ScanScope } from "../engine/scanner/scope.js";

/** Shared wording facts for renderers. Escaping belongs to each target format. */
export function scanScopeRows(scope: ScanScope): string[] {
  return scope.roots.map((item) =>
    item.matched
      ? `${item.root}: ${item.files} files, ${item.manifests} recognised manifests excluded`
      : `${item.root}: unmatched (0 files, 0 recognised manifests excluded)`,
  );
}

export function scanScopeSummary(scope: ScanScope): string {
  return `source ${scope.source}; ${scope.matchedRoots} matched roots; ${scope.excludedFiles} files, ${scope.excludedManifests} recognised manifests excluded; built-in policy ${scope.builtInPolicy}; digest ${scope.digest}`;
}
