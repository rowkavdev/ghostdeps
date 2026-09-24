/** Test helpers: RepositoryHandle implementations over fixtures and memory. */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RepositoryHandle } from "@ghostdeps/core";

/** Repository root, resolved from dist/testing/ (or src/testing/) at runtime. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);
export const FIXTURES_ROOT = path.join(REPO_ROOT, "fixtures");

export function fixtureHandle(...segments: string[]): RepositoryHandle {
  return fsHandle(path.join(FIXTURES_ROOT, ...segments));
}

/** Read-only handle over a directory on disk; paths come out posix-style. */
export function fsHandle(root: string): RepositoryHandle {
  async function walk(dir: string, prefix: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(...(await walk(path.join(dir, entry.name), rel)));
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
    return out.sort();
  }
  return {
    listFiles: () => walk(root, ""),
    readFile: (filePath: string) => readFile(path.join(root, filePath), "utf8"),
    async exists(filePath: string) {
      try {
        await stat(path.join(root, filePath));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** In-memory handle for synthetic cases. */
export function memoryHandle(files: Record<string, string>): RepositoryHandle {
  return {
    listFiles: () => Promise.resolve(Object.keys(files).sort()),
    readFile: (filePath: string) => {
      const content = files[filePath];
      if (content === undefined) return Promise.reject(new Error(`no such file: ${filePath}`));
      return Promise.resolve(content);
    },
    exists: (filePath: string) => Promise.resolve(filePath in files),
  };
}
