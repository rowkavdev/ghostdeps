/** Small shared path helpers (repo-relative, posix-style). */

export function joinPath(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

export function displayRoot(root: string): string {
  return root === "." ? "repository root" : root;
}

/** Directory of a repo-relative path; "." for top-level files. */
export function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
