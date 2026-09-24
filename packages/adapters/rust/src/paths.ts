/** Small shared path helpers (repo-relative, posix-style). */

export function joinPath(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

export function displayRoot(root: string): string {
  return root === "." ? "repository root" : root;
}

/** Directory part of a repo-relative file path ("a/b/Cargo.toml" -> "a/b", "Cargo.toml" -> "."). */
export function dirOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "." : file.slice(0, slash);
}

/** Normalise "a/./b/../c" style paths relative to the repository root. Undefined if it escapes. */
export function normalisePath(p: string): string | undefined {
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.length === 0 ? "." : out.join("/");
}

/** Relative path from directory `from` to file `to` (both repo-relative). */
export function relativePath(from: string, to: string): string {
  const a = from === "." ? [] : from.split("/");
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
