/**
 * pnpm-lock.yaml (lockfileVersion 6.x and 9.x). Parsed as data with the
 * `yaml` package (alias expansion capped, no custom tags); nothing is
 * resolved against a registry.
 */
import { parse } from "yaml";
import type { Evidence } from "@ghostdeps/core";
import { own } from "./model.js";
import { scopedOrigin, tarballOrigin } from "./origin.js";
import type { LoadedLockfile, ParsedLockfile, ResolvedPackage } from "./model.js";

type Rec = Record<string, unknown>;
const isObject = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Split "name@version" (name may be scoped) - the first "@" after position 0. */
function splitKey(key: string): { name: string; version: string } | undefined {
  const k = key.startsWith("/") ? key.slice(1) : key;
  const at = k.indexOf("@", 1);
  if (at <= 0) return undefined;
  return { name: k.slice(0, at), version: k.slice(at + 1) };
}

/** Strip the peer suffix: "1.0.0(react@18.2.0)" -> "1.0.0". */
const baseVersion = (v: string) => {
  const i = v.indexOf("(");
  return i < 0 ? v : v.slice(0, i);
};

/** Parse pnpm-lock.yaml text once; the result is shared read-only across importers. */
export function loadPnpmLockfile(text: string): LoadedLockfile {
  return { doc: parse(text, { maxAliasCount: 100, uniqueKeys: true }) as unknown };
}

export function parsePnpmLockfile(
  source: string | LoadedLockfile,
  lockfile: string,
  importerPath: string,
  declared: { name: string; dev: boolean }[],
  /** Scoped registry bindings from .npmrc (origin.ts); absent means none are trusted. */
  scopes?: ReadonlyMap<string, string | null>,
): ParsedLockfile {
  const evidence: Evidence[] = [];
  const { doc } = typeof source === "string" ? loadPnpmLockfile(source) : source;
  if (!isObject(doc)) throw new Error("lockfile root is not a mapping");
  const version = String(doc.lockfileVersion ?? "");
  const major = Number.parseInt(version, 10);
  const packages = new Map<string, ResolvedPackage>();
  const direct: ParsedLockfile["direct"] = declared.map((d) => ({ ...d, id: undefined }));

  if (major !== 6 && major !== 9) {
    evidence.push({
      kind: "lockfile-unsupported",
      statement: `${lockfile} has lockfileVersion ${version || "(missing)"}; only 6.x and 9.x are parsed`,
      file: lockfile,
    });
    return { packages, direct, evidence };
  }

  // v9 keeps edges in `snapshots` (keys "a@1.0.0(peer@1)"); v6 in `packages` (keys "/a@1.0.0(peer@1)").
  const table = (major === 9 ? doc.snapshots : doc.packages) ?? {};
  const prefix = major === 9 ? "" : "/";
  if (!isObject(table)) throw new Error("lockfile package table is not a mapping");

  /** Resolve a dependency reference (name + version field) to a table key. */
  const ref = (name: string, raw: unknown): string | undefined => {
    if (typeof raw !== "string" || raw.startsWith("link:") || raw.startsWith("file:"))
      return undefined;
    // Aliases: "string-width@4.2.3" (v9) or "/string-width@4.2.3" (v6).
    const alias = !/^\d/.test(raw) ? splitKey(raw) : undefined;
    const key = alias ? `${prefix}${alias.name}@${alias.version}` : `${prefix}${name}@${raw}`;
    return Object.hasOwn(table, key) ? key : undefined;
  };

  for (const [key, entry] of Object.entries(table)) {
    const parts = splitKey(key);
    if (!parts) continue;
    const deps: string[] = [];
    if (isObject(entry)) {
      for (const field of ["dependencies", "optionalDependencies"] as const) {
        const map = entry[field];
        if (!isObject(map)) continue;
        for (const [n, v] of Object.entries(map)) {
          const id = ref(n, v);
          if (id) deps.push(id);
        }
      }
    }
    const version = baseVersion(parts.version);
    // v9 keeps resolutions in `packages` keyed without the peer suffix; v6 on the entry itself.
    const meta =
      major === 9 && isObject(doc.packages) ? own(doc.packages, `${parts.name}@${version}`) : entry;
    const registryOrigin = pnpmOrigin(parts.name, version, meta, scopes);
    packages.set(key, {
      name: parts.name,
      version,
      dependencies: deps,
      ...(registryOrigin === undefined ? {} : { registryOrigin }),
    });
  }

  // Importers: workspace lockfiles have `importers`; v6 single-project lockfiles keep deps at the root.
  const importers = isObject(doc.importers) ? doc.importers : { ".": doc };
  const importer = own(importers, importerPath);
  if (!isObject(importer)) {
    evidence.push({
      kind: "lockfile-manifest-mismatch",
      statement: `${lockfile} has no importer for ${importerPath}; the lockfile is stale`,
      file: lockfile,
    });
    return { packages, direct, evidence };
  }
  const locked = new Map<string, unknown>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const map = importer[field];
    if (!isObject(map)) continue;
    for (const [n, v] of Object.entries(map)) locked.set(n, isObject(v) ? v.version : v);
  }
  for (const d of direct) {
    if (!locked.has(d.name)) {
      evidence.push({
        kind: "lockfile-manifest-mismatch",
        statement: `${d.name} is declared in the manifest but not in ${lockfile}; the lockfile is stale`,
        file: lockfile,
      });
      continue;
    }
    d.id = ref(d.name, locked.get(d.name));
  }
  const want = new Set(declared.map((d) => d.name));
  for (const n of locked.keys()) {
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

/**
 * registryOrigin for one pnpm package (#174 step 3). pnpm records no URL for
 * packages from the configured registry (integrity only), so:
 * - an explicit http(s) registry tarball in `resolution.tarball` is used;
 * - an integrity-only registry resolution takes the origin of the .npmrc
 *   binding for the package's scope, when that binding is unambiguous;
 * - anything else (git, directory, URL tarballs, unscoped packages, a bare
 *   `registry=` default, conflicting bindings) stays absent.
 */
function pnpmOrigin(
  name: string,
  version: string,
  meta: unknown,
  scopes: ReadonlyMap<string, string | null> | undefined,
): string | undefined {
  if (!isObject(meta)) return undefined;
  const resolution = own(meta, "resolution");
  if (!isObject(resolution)) return undefined;
  const tarball = own(resolution, "tarball");
  if (tarball !== undefined) return tarballOrigin(tarball, name);
  const keys = Object.keys(resolution);
  const integrityOnly =
    keys.length === 1 &&
    keys[0] === "integrity" &&
    typeof own(resolution, "integrity") === "string";
  if (!integrityOnly || !/^\d/.test(version)) return undefined;
  return scopedOrigin(name, scopes);
}
