/**
 * bun.lock (text lockfile, lockfileVersion 0/1). JSON with trailing commas;
 * parsed as data after a string-aware trailing-comma strip. The binary
 * bun.lockb format is not parsed (reported as unsupported by the builder).
 */
import type { Evidence } from "@ghostdeps/core";
import { own } from "./model.js";
import type { LoadedLockfile, ParsedLockfile, ResolvedPackage } from "./model.js";

type Rec = Record<string, unknown>;
const isObject = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Remove trailing commas before } or ] outside strings. */
export function stripTrailingCommas(text: string): string {
  const out: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92 /* \\ */) i++;
      else if (c === 34 /* " */) inString = false;
    } else if (c === 34) {
      inString = true;
    } else if (c === 44 /* , */) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
  }
  out.push(text.slice(start));
  return out.join("");
}

/** Split a bun package key ("a/@s/b/c") into package-name units. */
function units(key: string): string[] {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith("@") && i + 1 < parts.length) out.push(`${p}/${parts[++i]!}`);
    else out.push(p);
  }
  return out;
}

function splitIdent(ident: string): { name: string; version: string } {
  const at = ident.indexOf("@", 1);
  return at < 0
    ? { name: ident, version: "0.0.0" }
    : { name: ident.slice(0, at), version: ident.slice(at + 1) };
}

/** Parse bun.lock text once; shared read-only across importers. */
export function loadBunLockfile(text: string): LoadedLockfile {
  return { doc: JSON.parse(stripTrailingCommas(text)) as unknown };
}

export function parseBunLockfile(
  source: string | LoadedLockfile,
  lockfile: string,
  importerPath: string,
  declared: { name: string; dev: boolean }[],
): ParsedLockfile {
  const evidence: Evidence[] = [];
  const { doc } = typeof source === "string" ? loadBunLockfile(source) : source;
  if (!isObject(doc)) throw new Error("lockfile root is not an object");
  const table = isObject(doc.packages) ? doc.packages : {};
  const packages = new Map<string, ResolvedPackage>();

  /** Resolve dependency `dep` as seen from package key `from` (nested keys first, then hoisted). */
  const lookup = (from: string, dep: string): string | undefined => {
    const path = from ? units(from) : [];
    for (let n = path.length; n >= 0; n--) {
      const key = [...path.slice(0, n), dep].join("/");
      const value = own(table, key);
      if (Array.isArray(value) && typeof value[0] === "string") return key;
    }
    return undefined;
  };

  for (const [key, value] of Object.entries(table)) {
    if (!Array.isArray(value) || typeof value[0] !== "string") continue;
    const { name, version } = splitIdent(value[0]);
    const meta = value.find((v, i) => i > 0 && isObject(v)) as Rec | undefined;
    const deps: string[] = [];
    if (!version.startsWith("workspace:") && meta) {
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const map = own(meta, field);
        if (!isObject(map)) continue;
        for (const d of Object.keys(map)) {
          const id = lookup(key, d);
          if (id) deps.push(id);
        }
      }
    }
    packages.set(key, { name, version, dependencies: deps });
  }

  const direct: ParsedLockfile["direct"] = declared.map((d) => ({ ...d, id: undefined }));
  const workspaces = isObject(doc.workspaces) ? doc.workspaces : {};
  const ws = own(workspaces, importerPath === "." ? "" : importerPath);
  if (!isObject(ws)) {
    evidence.push({
      kind: "lockfile-manifest-mismatch",
      statement: `${lockfile} has no workspace entry for ${importerPath}; the lockfile is stale`,
      file: lockfile,
    });
    return { packages, direct, evidence };
  }
  const locked = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const map = own(ws, field);
    if (isObject(map)) for (const n of Object.keys(map)) locked.add(n);
  }
  // Workspace members may have nested copies under "<workspace name>/<dep>".
  const wsNameRaw = own(ws, "name");
  const wsName = typeof wsNameRaw === "string" ? wsNameRaw : undefined;
  for (const d of direct) {
    if (!locked.has(d.name)) {
      evidence.push({
        kind: "lockfile-manifest-mismatch",
        statement: `${d.name} is declared in the manifest but not in ${lockfile}; the lockfile is stale`,
        file: lockfile,
      });
      continue;
    }
    const nested = wsName && importerPath !== "." ? lookup(wsName, d.name) : undefined;
    d.id = nested ?? lookup("", d.name);
    if (d.id && packages.get(d.id)?.version.startsWith("workspace:")) d.id = undefined;
  }
  const want = new Set(declared.map((d) => d.name));
  for (const n of locked) {
    if (!want.has(n)) {
      evidence.push({
        kind: "lockfile-manifest-mismatch",
        statement: `${lockfile} lists ${n} as a direct dependency but the manifest does not; the lockfile is stale`,
        file: lockfile,
      });
    }
  }
  return { packages, direct, evidence };
}
