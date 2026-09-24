/** Small shared path helpers (repo-relative, posix-style). */

export function joinPath(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

export function displayRoot(root: string): string {
  return root === "." ? "repository root" : root;
}
