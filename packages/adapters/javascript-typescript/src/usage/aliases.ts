/**
 * tsconfig/jsconfig path aliases (issue #29), resolved statically.
 *
 * `compilerOptions.paths` and `baseUrl` let a project import its own files
 * with bare-looking specifiers ("@app/db", "utils/log"). Those must never be
 * counted as usage of an npm package with the same name. Config files are
 * parsed as JSON-with-comments text (ts.parseConfigFileTextToJson): no
 * Program, no module resolution, and nothing is evaluated. Only relative
 * `extends` inside the repository is followed. Package bases
 * ("@tsconfig/node20") are not resolved (ADR 0004: no resolution).
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
/** Maximum `paths` entries honoured per config; the rest are ignored with a limitation. */
export const MAX_PATH_ENTRIES = 1_000;
/** Maximum targets considered per `paths` entry. */
const MAX_TARGETS_PER_ENTRY = 16;

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
  extendsFile: string | undefined;
}

interface RawConfig {
  baseUrl?: string;
  paths?: PathEntry[];
  /** Directory of the file that set `paths`. */
  pathsDir?: string;
}

/** Alias resolution for one repository listing. Create one per scan. */
export class AliasResolver {
  private readonly files: Set<string>;
  private readonly dirs: Set<string>;
  private readonly raw = new Map<string, Promise<ParsedConfigFile | undefined>>();
  private readonly effective = new Map<string, Promise<AliasConfig | undefined>>();
  readonly limitations: Evidence[] = [];

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
    const chain: RawConfig[] = [];
    const seen = new Set<string>();
    let current: string | undefined = configFile;
    let depth = 0;
    while (current !== undefined) {
      if (seen.has(current)) {
        this.limit(
          "tsconfig-extends-cycle",
          `${configFile} has a circular extends chain`,
          configFile,
        );
        break;
      }
      if (depth > MAX_EXTENDS_DEPTH) {
        this.limit(
          "tsconfig-extends-too-deep",
          `${configFile} extends more than ${MAX_EXTENDS_DEPTH} levels; the rest was not read`,
          configFile,
        );
        break;
      }
      seen.add(current);
      depth += 1;
      const parsed = await this.readRaw(current);
      if (!parsed) break;
      chain.push(parsed.config);
      current = parsed.extendsFile;
    }
    // Nearest config wins: walk from the base outward.
    const merged: RawConfig = {};
    for (const raw of chain.reverse()) {
      if (raw.baseUrl !== undefined) merged.baseUrl = raw.baseUrl;
      if (raw.paths !== undefined) {
        merged.paths = raw.paths;
        if (raw.pathsDir !== undefined) merged.pathsDir = raw.pathsDir;
      }
    }
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
    return { config: raw, extendsFile: this.localExtends(own(config, "extends"), dir) };
  }

  /** First relative `extends` target that is a listed repository file; package bases are skipped. */
  private localExtends(value: unknown, dir: string): string | undefined {
    const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    // TS 5 array extends: later entries override earlier ones, so the last local one is the nearest base.
    for (const entry of [...list].reverse()) {
      if (typeof entry !== "string" || !(entry.startsWith("./") || entry.startsWith("../")))
        continue;
      const target = joinPath(dir, entry);
      if (target === undefined) continue;
      if (this.files.has(target)) return target;
      if (this.files.has(`${target}.json`)) return `${target}.json`;
    }
    return undefined;
  }

  private limit(kind: string, statement: string, file: string): void {
    if (this.limitations.some((e) => e.kind === kind && e.file === file)) return;
    this.limitations.push({ kind, statement, file });
  }
}
