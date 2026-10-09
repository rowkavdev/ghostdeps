/**
 * tsconfig/jsconfig path aliases (issue #29), resolved statically.
 *
 * `compilerOptions.paths` and `baseUrl` let a project import its own files
 * with bare-looking specifiers ("@app/db", "utils/log"). Those must never be
 * counted as usage of an npm package with the same name. Config files are
 * parsed as JSON-with-comments text (ts.parseConfigFileTextToJson): no
 * Program, no module resolution, and nothing is evaluated. Relative
 * `extends` inside the repository is followed, and so is a base that names
 * a workspace package in this repository ("@repo/typescript-config/base.json",
 * #145), found by the package.json `name` fields in the listing. A base
 * naming a workspace package that doesn't contain it becomes a limitation.
 * A base naming a node_modules package ("@tsconfig/node20") is resolved
 * statically when the installed files are in the listing (#276): `exports`
 * (a root string, exact and single-star subpaths, and conditional objects
 * over TypeScript's accepted conditions; array fallbacks are not resolved),
 * the package's `tsconfig` field, the `.json` suffix and the directory
 * `tsconfig.json`, walking up from the referencing config the way
 * TypeScript does. Nothing is evaluated (ADR 0004). Bases that
 * are not installed - the usual CI checkout - are not read and are
 * reported once per run.
 *
 * Conservative rule: a specifier counts as internal only when an alias
 * target resolves to a file that is actually in the repository listing.
 * A catch-all like `"*": ["node_modules/*"]` therefore never hides real
 * package usage, because dropping usage is the direction that can produce
 * a false "unused".
 */
import ts from "typescript";
import type { Evidence, RepositoryHandle } from "@ghostdeps/core";

/** Config files larger than this are not parsed (security-model: parser input limits). */
export const MAX_CONFIG_BYTES = 256 * 1024;
/** Maximum `extends` chain length followed. */
export const MAX_EXTENDS_DEPTH = 8;
/** Maximum distinct `extends` bases merged per config resolution (#862). */
export const MAX_EXTENDS_BASES = 32;
/** Maximum `paths` entries honoured per config; the rest are ignored with a limitation. */
export const MAX_PATH_ENTRIES = 1_000;
/** Maximum targets considered per `paths` entry. */
const MAX_TARGETS_PER_ENTRY = 16;
/** Most package.json files read to map workspace package names (#145). */
export const MAX_WORKSPACE_MANIFESTS = 5_000;
/** Memoised isInternal answers kept per config file (#145). */
const MAX_MEMO_PER_CONFIG = 50_000;
/** Distinct node_modules extends bases remembered for the run note. */
const MAX_PACKAGE_BASES = 1_000;

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;
const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

interface PathEntry {
  key: string;
  targets: string[];
}

/** Effective alias settings for one config file, after following `extends`. */
export interface AliasConfig {
  /** Repository-relative config file these settings came from. */
  configFile: string;
  /** Repository-relative directory `baseUrl` points at, if set. */
  baseUrl?: string;
  /** Directory `paths` targets are relative to (baseUrl, else the config that defined `paths`). */
  pathsBase?: string;
  paths: PathEntry[];
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

/** Posix join + normalise; undefined when the path escapes the repository root. */
export function joinPath(dir: string, rel: string): string | undefined {
  const out: string[] = [];
  for (const seg of `${dir === "." ? "" : dir}/${rel}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(seg);
  }
  return out.length === 0 ? "." : out.join("/");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

interface ParsedConfigFile {
  config: RawConfig;
  extendsFiles: string[];
}

/** "<name>" or "<name>/<subpath>" for a package-style extends value. */
const PACKAGE_EXTENDS = /^((?:@[^/]+\/)?[^/@.][^/]*)(?:\/(.+))?$/;

/**
 * `exports` conditions TypeScript accepts when resolving a tsconfig extends
 * (verified against 5.9.3): the first key in this set, in object order,
 * wins - "types" and "node" beat "default" when listed first, "require"
 * beats "import", and unknown conditions ("browser") are skipped.
 */
const EXPORTS_CONDITIONS: ReadonlySet<string> = new Set(["types", "node", "require", "default"]);
/** Deepest conditional-`exports` nesting followed. */
const MAX_CONDITION_DEPTH = 4;

function packageName(entry: string): string | undefined {
  return PACKAGE_EXTENDS.exec(entry)?.[1];
}

interface WorkspacePackage {
  dir: string;
  /** package.json `tsconfig` field: the base `extends: "<name>"` loads. */
  tsconfig?: string;
  /** More than one package.json has this name; extends through it isn't followed. */
  ambiguous?: true;
}

interface RawConfig {
  baseUrl?: string;
  paths?: PathEntry[];
  /** Directory of the file that set `paths`. */
  pathsDir?: string;
}

/** Alias resolution for one repository listing. Create one per scan. */
/** A later config replaces only the options it defines. */
function overrideOptions(target: RawConfig, source: RawConfig): void {
  if (source.baseUrl !== undefined) target.baseUrl = source.baseUrl;
  if (source.paths === undefined) return;
  target.paths = source.paths;
  if (source.pathsDir !== undefined) target.pathsDir = source.pathsDir;
}

function cacheMerge(
  cache: Map<string, Map<number, RawConfig>>,
  file: string,
  depth: number,
  merged: RawConfig,
): void {
  let byDepth = cache.get(file);
  if (!byDepth) {
    byDepth = new Map();
    cache.set(file, byDepth);
  }
  byDepth.set(depth, merged);
}

export class AliasResolver {
  private readonly files: Set<string>;
  private readonly dirs: Set<string>;
  private readonly raw = new Map<string, Promise<ParsedConfigFile | undefined>>();
  private readonly effective = new Map<string, Promise<AliasConfig | undefined>>();
  private readonly memo = new Map<string, Map<string, boolean>>();
  private workspace: Promise<Map<string, WorkspacePackage>> | undefined;
  /** Memoised node_modules extends resolutions, keyed by referencing directory + entry (#276). */
  private readonly nmBases = new Map<string, Promise<string | undefined>>();
  /** Memoised node_modules package.json reads (#276). */
  private readonly nmManifests = new Map<string, Promise<Record<string, unknown> | undefined>>();
  readonly limitations: Evidence[] = [];
  /**
   * `extends` bases from node_modules packages that were not read (#276),
   * by package name - not installed, or not resolvable the way TypeScript
   * resolves them. Reported once per run as a non-capping adapter note,
   * never a limitation: an unknown alias can only add usage.
   */
  readonly packageBases = new Set<string>();

  constructor(
    private readonly repository: RepositoryHandle,
    files: Iterable<string>,
  ) {
    this.files = new Set(files);
    this.dirs = new Set();
    for (const f of this.files) {
      for (let d = dirname(f); ; d = dirname(d)) {
        if (this.dirs.has(d)) break;
        this.dirs.add(d);
        if (d === ".") break;
      }
    }
  }

  /** Nearest tsconfig.json / jsconfig.json at or above `dir`, stopping at `stopAt` (a project root). */
  nearestConfig(dir: string, stopAt = "."): string | undefined {
    for (let d = dir; ; d = dirname(d)) {
      for (const name of CONFIG_NAMES) {
        const candidate = d === "." ? name : `${d}/${name}`;
        if (this.files.has(candidate)) return candidate;
      }
      if (d === stopAt || d === ".") return undefined;
    }
  }

  /** Effective settings for a config file (memoised). */
  configFor(configFile: string): Promise<AliasConfig | undefined> {
    let pending = this.effective.get(configFile);
    if (!pending) {
      pending = this.resolveEffective(configFile);
      this.effective.set(configFile, pending);
    }
    return pending;
  }

  /** True when `specifier`, imported from a file governed by `config`, resolves to a repository file via an alias. */
  isInternal(specifier: string, config: AliasConfig): boolean {
    let answers = this.memo.get(config.configFile);
    if (!answers) this.memo.set(config.configFile, (answers = new Map()));
    const known = answers.get(specifier);
    if (known !== undefined) return known;
    const result = this.computeInternal(specifier, config);
    if (answers.size < MAX_MEMO_PER_CONFIG) answers.set(specifier, result);
    return result;
  }

  private computeInternal(specifier: string, config: AliasConfig): boolean {
    if (config.pathsBase !== undefined) {
      for (const entry of config.paths) {
        const star = entry.key.indexOf("*");
        let captured: string | undefined;
        if (star < 0) {
          if (specifier === entry.key) captured = "";
        } else {
          const prefix = entry.key.slice(0, star);
          const suffix = entry.key.slice(star + 1);
          if (
            specifier.length >= prefix.length + suffix.length &&
            specifier.startsWith(prefix) &&
            specifier.endsWith(suffix)
          ) {
            captured = specifier.slice(prefix.length, specifier.length - suffix.length);
          }
        }
        if (captured === undefined) continue;
        for (const target of entry.targets) {
          const rel = target.includes("*") ? target.replace("*", captured) : target;
          if (this.resolvesToFile(config.pathsBase, rel)) return true;
        }
      }
    }
    if (config.baseUrl !== undefined && this.resolvesToFile(config.baseUrl, specifier)) return true;
    return false;
  }

  private resolvesToFile(base: string, rel: string): boolean {
    const target = joinPath(base, rel);
    if (target === undefined || target.split("/").includes("node_modules")) return false;
    for (const ext of RESOLVE_EXTENSIONS) {
      if (ext && this.files.has(`${target}${ext}`)) return true;
      if (!ext && target !== "." && this.files.has(target)) return true;
    }
    if (this.dirs.has(target)) {
      for (const ext of RESOLVE_EXTENSIONS.slice(1)) {
        if (this.files.has(target === "." ? `index${ext}` : `${target}/index${ext}`)) return true;
      }
    }
    return false;
  }

  private async resolveEffective(configFile: string): Promise<AliasConfig | undefined> {
    // TS 5 array extends: every resolvable base is merged in array order and
    // a later base replaces only the options it defines (#862). The walk is a
    // DAG, not a chain: cycles are detected against the current path, depth
    // against MAX_EXTENDS_DEPTH, and breadth against MAX_EXTENDS_BASES counted
    // in a DISTINCT-seen set, separate from the cache. Merges are cached per
    // remaining depth budget (keyed by stack length, so a depth-truncated
    // merge never serves a shallower visit and a full merge never serves a
    // deeper one) and their effect still applied at every edge in order, so
    // a shared base repeated across many arms costs one slot. A merge whose
    // subtree touched a cycle cut depends on the path taken, so it is never
    // cached and neither is any ancestor's merge; acyclic sibling subtrees
    // still cache. All caps fail closed (the unmerged options stay unknown).
    const cache = new Map<string, Map<number, RawConfig>>();
    const seen = new Set<string>();
    let breadthNoted = false;
    const merge = async (
      file: string,
      stack: readonly string[],
    ): Promise<{ config: RawConfig | undefined; cycleTainted: boolean }> => {
      const hit = cache.get(file)?.get(stack.length);
      if (hit !== undefined) return { config: hit, cycleTainted: false };
      if (stack.includes(file)) {
        this.limit(
          "tsconfig-extends-cycle",
          `${configFile} has a circular extends chain`,
          configFile,
        );
        return { config: undefined, cycleTainted: true };
      }
      if (stack.length > MAX_EXTENDS_DEPTH) {
        this.limit(
          "tsconfig-extends-too-deep",
          `${configFile} extends more than ${MAX_EXTENDS_DEPTH} levels; the rest was not read`,
          configFile,
        );
        return { config: undefined, cycleTainted: false };
      }
      if (stack.length > 0 && !seen.has(file)) {
        if (seen.size >= MAX_EXTENDS_BASES) {
          if (!breadthNoted) {
            breadthNoted = true;
            this.limit(
              "tsconfig-extends-too-broad",
              `${configFile} extends more than ${MAX_EXTENDS_BASES} distinct bases; the rest were not read`,
              configFile,
            );
          }
          return { config: undefined, cycleTainted: false };
        }
        seen.add(file);
      }
      const parsed = await this.readRaw(file);
      if (!parsed) return { config: undefined, cycleTainted: false };
      const merged: RawConfig = {};
      let tainted = false;
      for (const base of parsed.extendsFiles) {
        const res = await merge(base, [...stack, file]);
        // A cycle cut anywhere below makes this merge path-dependent: it and
        // every ancestor stay uncached, while sibling subtrees computed from
        // scratch keep their cache.
        if (res.cycleTainted) tainted = true;
        if (res.config === undefined) continue;
        overrideOptions(merged, res.config);
      }
      overrideOptions(merged, parsed.config);
      if (!tainted) cacheMerge(cache, file, stack.length, merged);
      return { config: merged, cycleTainted: tainted };
    };
    const root = await merge(configFile, []);
    const merged = root.config;
    if (merged === undefined) return undefined;
    const out: AliasConfig = { configFile, paths: merged.paths ?? [] };
    if (merged.baseUrl !== undefined) out.baseUrl = merged.baseUrl;
    const pathsBase = merged.baseUrl ?? merged.pathsDir;
    if (merged.paths !== undefined && pathsBase !== undefined) out.pathsBase = pathsBase;
    return out;
  }

  private readRaw(file: string): Promise<ParsedConfigFile | undefined> {
    let pending = this.raw.get(file);
    if (!pending) {
      pending = this.parseFile(file);
      this.raw.set(file, pending);
    }
    return pending;
  }

  private async parseFile(file: string): Promise<ParsedConfigFile | undefined> {
    if (!this.files.has(file)) return undefined;
    let text: string;
    try {
      text = await this.repository.readFile(file);
    } catch {
      this.limit(
        "tsconfig-unreadable",
        `could not read ${file}; its path aliases are unknown`,
        file,
      );
      return undefined;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
      this.limit(
        "tsconfig-too-large",
        `${file} exceeds ${MAX_CONFIG_BYTES} bytes and was not parsed; its path aliases are unknown`,
        file,
      );
      return undefined;
    }
    const { config, error } = ts.parseConfigFileTextToJson(file, text);
    if (error || !isRecord(config)) {
      this.limit(
        "tsconfig-malformed",
        `${file} could not be parsed; its path aliases are unknown`,
        file,
      );
      return undefined;
    }
    const dir = dirname(file);
    const raw: RawConfig = {};
    const options = own(config, "compilerOptions");
    if (isRecord(options)) {
      const baseUrl = own(options, "baseUrl");
      if (typeof baseUrl === "string") {
        const resolved = joinPath(dir, baseUrl);
        if (resolved !== undefined) raw.baseUrl = resolved;
      }
      const paths = own(options, "paths");
      if (isRecord(paths)) {
        const entries: PathEntry[] = [];
        const keys = Object.keys(paths);
        for (const key of keys.slice(0, MAX_PATH_ENTRIES)) {
          const targets = own(paths, key);
          if (!Array.isArray(targets) || (key.match(/\*/g)?.length ?? 0) > 1) continue;
          entries.push({
            key,
            targets: targets
              .filter(
                (t): t is string => typeof t === "string" && (t.match(/\*/g)?.length ?? 0) <= 1,
              )
              .slice(0, MAX_TARGETS_PER_ENTRY),
          });
        }
        if (keys.length > MAX_PATH_ENTRIES) {
          this.limit(
            "tsconfig-paths-truncated",
            `${file} has ${keys.length} paths entries; only the first ${MAX_PATH_ENTRIES} were honoured`,
            file,
          );
        }
        raw.paths = entries;
        raw.pathsDir = dir;
      }
    }
    return {
      config: raw,
      extendsFiles: await this.localExtends(own(config, "extends"), dir, file),
    };
  }

  /**
   * Every resolvable `extends` base, in array order (#862): relative paths,
   * paths inside workspace packages of this repository (#145), or files
   * inside installed node_modules packages (#276). node_modules bases that
   * are not installed are skipped and recorded for the run note.
   */
  private async localExtends(value: unknown, dir: string, file: string): Promise<string[]> {
    const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    const bases: string[] = [];
    // TS 5 array extends: later entries override earlier ones per option, so
    // every resolvable entry is returned for the merge.
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      if (entry.startsWith("./") || entry.startsWith("../")) {
        const target = joinPath(dir, entry);
        if (target === undefined) continue;
        const hit = this.files.has(target)
          ? target
          : this.files.has(`${target}.json`)
            ? `${target}.json`
            : undefined;
        if (target.split("/").includes("node_modules")) {
          // A relative path into node_modules: read it when the listing has
          // the file (installed); otherwise record the base for the run note.
          if (hit !== undefined) {
            bases.push(hit);
          } else {
            const nm = target.split("/").indexOf("node_modules");
            const pkg = packageName(
              target
                .split("/")
                .slice(nm + 1)
                .join("/"),
            );
            if (pkg !== undefined) this.notePackageBase(pkg);
          }
          continue;
        }
        if (hit !== undefined) bases.push(hit);
        continue;
      }
      const pkg = packageName(entry);
      if (pkg === undefined) continue;
      if ((await this.workspacePackages()).has(pkg)) {
        const resolved = await this.workspaceExtends(entry, file);
        if (resolved !== undefined) bases.push(resolved);
        continue;
      }
      const resolved = await this.nodeModulesExtends(entry, dir);
      if (resolved !== undefined) {
        bases.push(resolved);
      } else {
        this.notePackageBase(pkg);
      }
    }
    return bases;
  }

  /**
   * `extends` naming a node_modules package ("@tsconfig/node20",
   * "expo/tsconfig.base"), resolved statically from the listing the way
   * TypeScript resolves it (#276): walk up from the referencing config's
   * directory; at the nearest level where the package is present, consult
   * `exports` (exact key or single-star pattern; a miss is final, so a
   * base the package does not export is never read), then the `tsconfig`
   * field for a bare name, then the file, the file with a `.json` suffix,
   * and the directory `tsconfig.json`. Bounded reads, nothing evaluated.
   */
  private nodeModulesExtends(entry: string, fromDir: string): Promise<string | undefined> {
    const key = `${fromDir}\n${entry}`;
    let pending = this.nmBases.get(key);
    if (!pending) {
      // Past the cap, neither resolve nor memoize new keys: bounded work and
      // bounded memory per run, and the base is noted as unread instead.
      if (this.nmBases.size >= MAX_PACKAGE_BASES) return Promise.resolve(undefined);
      pending = this.resolveNodeModulesBase(entry, fromDir);
      this.nmBases.set(key, pending);
    }
    return pending;
  }

  private async resolveNodeModulesBase(
    entry: string,
    fromDir: string,
  ): Promise<string | undefined> {
    const m = PACKAGE_EXTENDS.exec(entry);
    if (!m) return undefined;
    const name = m[1]!;
    const sub = m[2];
    for (let d = fromDir; ; d = dirname(d)) {
      const nm = d === "." ? "node_modules" : `${d}/node_modules`;
      const pkgDir = `${nm}/${name}`;
      const manifestPath = `${pkgDir}/package.json`;
      const manifest = this.files.has(manifestPath)
        ? await this.readNodeModulesManifest(manifestPath)
        : undefined;
      const present =
        manifest !== undefined ||
        this.dirs.has(pkgDir) ||
        (sub === undefined && this.files.has(`${nm}/${name}.json`));
      if (present) {
        // The nearest installed copy wins; failing to resolve through it
        // does not fall through to a copy higher up (TypeScript semantics).
        const exportsField = manifest !== undefined ? own(manifest, "exports") : undefined;
        if (typeof exportsField === "string" || isRecord(exportsField)) {
          return this.exportsTarget(exportsField, sub === undefined ? "." : `./${sub}`, pkgDir);
        }
        if (sub === undefined) {
          const field = manifest !== undefined ? own(manifest, "tsconfig") : undefined;
          if (typeof field === "string") {
            const t = joinPath(pkgDir, field);
            if (t !== undefined && (t === pkgDir || t.startsWith(`${pkgDir}/`))) {
              if (this.files.has(t)) return t;
            }
          }
        }
        const rest = sub === undefined ? `${nm}/${name}` : `${pkgDir}/${sub}`;
        if (this.files.has(rest)) return rest;
        if (this.files.has(`${rest}.json`)) return `${rest}.json`;
        const dirBase = `${rest}/tsconfig.json`;
        if (this.files.has(dirBase)) return dirBase;
        return undefined;
      }
      if (d === ".") return undefined;
    }
  }

  /**
   * One package.json read from node_modules, memoised and size-bounded.
   * A resolution reads at most one manifest, so the shared cap can never be
   * reached before the nmBases cap stops new resolutions; the check is
   * defence in depth. Past it, the manifest counts as unreadable and
   * resolution falls back to the file-based candidates.
   */
  private readNodeModulesManifest(path: string): Promise<Record<string, unknown> | undefined> {
    let pending = this.nmManifests.get(path);
    if (!pending) {
      if (this.nmManifests.size >= MAX_PACKAGE_BASES) return Promise.resolve(undefined);
      pending = (async () => {
        let text: string;
        try {
          text = await this.repository.readFile(path);
        } catch {
          return undefined;
        }
        if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return undefined;
        try {
          const doc: unknown = JSON.parse(text);
          return isRecord(doc) ? doc : undefined;
        } catch {
          return undefined;
        }
      })();
      this.nmManifests.set(path, pending);
    }
    return pending;
  }

  /**
   * `exports` lookup for "." or a "./sub" key. A root string export covers
   * only "."; object values may be strings or conditional objects, resolved
   * in object order over TypeScript's accepted conditions. Array fallbacks
   * are not resolved. Only "./" targets inside the package are honoured.
   */
  private exportsTarget(
    exportsField: string | Record<string, unknown>,
    key: string,
    pkgDir: string,
  ): string | undefined {
    let target: string | undefined;
    if (typeof exportsField === "string") {
      if (key === ".") target = exportsField;
    } else {
      const keys = Object.keys(exportsField).slice(0, MAX_PATH_ENTRIES);
      if (keys.includes(key)) {
        target = this.conditionTarget(own(exportsField, key));
      } else {
        for (const k of keys) {
          const star = k.indexOf("*");
          if (star < 0 || k.indexOf("*", star + 1) >= 0) continue;
          const prefix = k.slice(0, star);
          const suffix = k.slice(star + 1);
          if (
            key.length < prefix.length + suffix.length ||
            !key.startsWith(prefix) ||
            !key.endsWith(suffix)
          ) {
            continue;
          }
          const v = this.conditionTarget(own(exportsField, k));
          target =
            v !== undefined && (v.match(/\*/g)?.length ?? 0) === 1
              ? v.replace("*", key.slice(prefix.length, key.length - suffix.length))
              : undefined;
          break;
        }
      }
    }
    if (target === undefined || !target.startsWith("./")) return undefined;
    const t = joinPath(pkgDir, target);
    if (t === undefined || (t !== pkgDir && !t.startsWith(`${pkgDir}/`))) return undefined;
    return this.files.has(t) ? t : undefined;
  }

  /**
   * The first matching condition in object order over TypeScript's accepted
   * set, recursing into nested condition objects. Strings must be "./"
   * paths; anything else (arrays, non-string leaves, deep nesting) is not
   * resolved.
   */
  private conditionTarget(value: unknown, depth = 0): string | undefined {
    if (typeof value === "string") return value.startsWith("./") ? value : undefined;
    if (!isRecord(value) || depth >= MAX_CONDITION_DEPTH) return undefined;
    for (const k of Object.keys(value).slice(0, MAX_PATH_ENTRIES)) {
      if (!EXPORTS_CONDITIONS.has(k)) continue;
      const t = this.conditionTarget(own(value, k), depth + 1);
      if (t !== undefined) return t;
    }
    return undefined;
  }

  private notePackageBase(pkg: string): void {
    if (this.packageBases.size < MAX_PACKAGE_BASES) this.packageBases.add(pkg);
  }

  /** `extends` naming a workspace package: "<name>/<file>" or "<name>" (its `tsconfig` field, else tsconfig.json). */
  private async workspaceExtends(entry: string, file: string): Promise<string | undefined> {
    const m = PACKAGE_EXTENDS.exec(entry);
    if (!m) return undefined;
    const pkg = (await this.workspacePackages()).get(m[1]!);
    if (pkg === undefined) return undefined;
    if (pkg.ambiguous) {
      this.limit(
        "tsconfig-extends-ambiguous",
        `${file} extends "${entry}", but more than one package.json in the repository is named ${m[1]!}; aliases it defines are unknown`,
        file,
      );
      return undefined;
    }
    const candidates: string[] = [];
    const sub = m[2];
    if (sub !== undefined) candidates.push(sub, `${sub}.json`);
    else candidates.push(...(pkg.tsconfig !== undefined ? [pkg.tsconfig] : []), "tsconfig.json");
    for (const rel of candidates) {
      const target = joinPath(pkg.dir, rel);
      // Stay inside the package: "../" out of it is not what the name means.
      const inside = target !== undefined && (pkg.dir === "." || target.startsWith(`${pkg.dir}/`));
      if (inside && this.files.has(target)) return target;
    }
    this.limit(
      "tsconfig-extends-unresolved",
      `${file} extends "${entry}", a workspace package that has no such file; aliases it defines are unknown`,
      file,
    );
    return undefined;
  }

  /** Workspace package name -> directory, from package.json files in the listing (read once, bounded). */
  private workspacePackages(): Promise<Map<string, WorkspacePackage>> {
    this.workspace ??= (async () => {
      const out = new Map<string, WorkspacePackage>();
      // Workspace packages are repository packages; installed copies under
      // node_modules are resolved as node_modules bases (#276), not here.
      const manifests = [...this.files]
        .filter(
          (f) =>
            (f === "package.json" || f.endsWith("/package.json")) &&
            !f.split("/").includes("node_modules"),
        )
        .sort();
      if (manifests.length > MAX_WORKSPACE_MANIFESTS) {
        this.limit(
          "tsconfig-workspace-map-truncated",
          `${manifests.length} package.json files; only the first ${MAX_WORKSPACE_MANIFESTS} were read to resolve tsconfig extends`,
          manifests[MAX_WORKSPACE_MANIFESTS]!,
        );
      }
      for (const manifest of manifests.slice(0, MAX_WORKSPACE_MANIFESTS)) {
        let doc: unknown;
        try {
          const text = await this.repository.readFile(manifest);
          if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) continue;
          doc = JSON.parse(text);
        } catch {
          continue; // manifest problems are reported by manifest parsing
        }
        if (!isRecord(doc)) continue;
        const name = own(doc, "name");
        if (typeof name !== "string") continue;
        if (out.has(name)) {
          // Two packages with one name (e.g. a fixture copy): which one an
          // extends means is ambiguous, so neither is followed.
          out.set(name, { dir: out.get(name)!.dir, ambiguous: true });
          continue;
        }
        const tsconfig = own(doc, "tsconfig");
        out.set(name, {
          dir: dirname(manifest),
          ...(typeof tsconfig === "string" ? { tsconfig } : {}),
        });
      }
      return out;
    })();
    return this.workspace;
  }

  private limit(kind: string, statement: string, file: string): void {
    if (this.limitations.some((e) => e.kind === kind && e.file === file)) return;
    this.limitations.push({ kind, statement, file });
  }
}
