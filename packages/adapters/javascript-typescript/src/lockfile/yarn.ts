/**
 * yarn.lock - Yarn classic (v1 custom format) and Yarn Berry (2+, YAML with
 * `__metadata`). Parsed as data; nothing is resolved against a registry.
 */
import { parse } from "yaml";
import type { Evidence } from "@ghostdeps/core";
import type { ParsedLockfile, ResolvedPackage } from "./model.js";

type Rec = Record<string, unknown>;
const isObject = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? (JSON.parse(t) as string) : t;
};

/** Name part of a "name@range" pattern (scoped names keep their leading @). */
function patternName(pattern: string): string {
  const at = pattern.indexOf("@", 1);
  return at < 0 ? pattern : pattern.slice(0, at);
}

/**
 * Minimal reader for the Yarn classic format: top-level entries keyed by
 * comma-separated patterns, indented `key value` fields and one level of
 * nested maps (dependencies, optionalDependencies). Unknown lines are
 * ignored; structural problems throw.
 */
export function readClassicLockfile(text: string): Map<string, Rec> {
  const entries = new Map<string, Rec>();
  let current: Rec | undefined;
  let nested: Rec | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      if (!line.endsWith(":")) throw new Error(`line ${i + 1}: expected an entry header`);
      current = {};
      nested = undefined;
      for (const p of line.slice(0, -1).split(",")) entries.set(unquote(p), current);
    } else if (!current) {
      throw new Error(`line ${i + 1}: field outside an entry`);
    } else if (indent === 2) {
      if (line.endsWith(":")) {
        nested = {};
        current[unquote(line.slice(0, -1))] = nested;
      } else {
        nested = undefined;
        const sp = line.search(/\s/);
        if (sp > 0) current[unquote(line.slice(0, sp))] = unquote(line.slice(sp + 1));
      }
    } else if (nested) {
      const m = /^("(?:[^"\\]|\\.)*"|\S+)\s+(.+)$/.exec(line);
      if (m) nested[unquote(m[1]!)] = unquote(m[2]!);
    }
  }
  return entries;
}

export function parseYarnLockfile(
  text: string,
  lockfile: string,
  importerPath: string,
  declared: { name: string; dev: boolean; constraint: string }[],
): ParsedLockfile {
  const evidence: Evidence[] = [];
  const packages = new Map<string, ResolvedPackage>();
  const direct: ParsedLockfile["direct"] = declared.map((d) => ({
    name: d.name,
    dev: d.dev,
    id: undefined,
  }));
  const berry = /^__metadata:/m.test(text);

  // Both formats: pattern -> entry. Package id = the entry's first pattern.
  const byPattern = new Map<string, { id: string; entry: Rec }>();
  if (berry) {
    const doc: unknown = parse(text, { maxAliasCount: 100, uniqueKeys: true });
    if (!isObject(doc)) throw new Error("lockfile root is not a mapping");
    for (const [key, entry] of Object.entries(doc)) {
      if (key === "__metadata" || !isObject(entry)) continue;
      const patterns = key.split(",").map((p) => p.trim());
      for (const p of patterns) byPattern.set(p, { id: patterns[0]!, entry });
    }
  } else {
    const seen = new Map<Rec, string>();
    for (const [p, entry] of readClassicLockfile(text)) {
      if (!seen.has(entry)) seen.set(entry, p);
      byPattern.set(p, { id: seen.get(entry)!, entry });
    }
  }

  const lookup = (name: string, range: string): string | undefined => {
    const candidates = berry ? [`${name}@${range}`, `${name}@npm:${range}`] : [`${name}@${range}`];
    for (const c of candidates) {
      const hit = byPattern.get(c);
      if (hit) return hit.id;
    }
    return undefined;
  };

  for (const { id, entry } of byPattern.values()) {
    if (packages.has(id)) continue;
    const resolution = typeof entry.resolution === "string" ? entry.resolution : id;
    const deps: string[] = [];
    for (const field of ["dependencies", "optionalDependencies"]) {
      const map = entry[field];
      if (!isObject(map)) continue;
      for (const [n, r] of Object.entries(map)) {
        const dep = lookup(n, String(r));
        if (dep) deps.push(dep);
      }
    }
    packages.set(id, {
      name: patternName(resolution),
      version: String(entry.version ?? "0.0.0"),
      dependencies: deps,
    });
  }

  if (berry) {
    const ws = [...byPattern.values()].find(
      ({ entry }) =>
        typeof entry.resolution === "string" &&
        entry.resolution.endsWith(`@workspace:${importerPath}`),
    );
    if (!ws) {
      evidence.push({
        kind: "lockfile-manifest-mismatch",
        statement: `${lockfile} has no workspace entry for ${importerPath}; the lockfile is stale`,
        file: lockfile,
      });
      return { packages, direct, evidence };
    }
    const locked = new Map<string, string>();
    for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
      const map = ws.entry[field];
      if (isObject(map)) for (const [n, r] of Object.entries(map)) locked.set(n, String(r));
    }
    for (const d of direct) {
      const r = locked.get(d.name);
      if (r === undefined) {
        evidence.push({
          kind: "lockfile-manifest-mismatch",
          statement: `${d.name} is declared in the manifest but not in ${lockfile}; the lockfile is stale`,
          file: lockfile,
        });
      } else {
        d.id = lookup(d.name, r);
      }
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
  } else {
    // Classic lockfiles don't record the project's own edges; match by the manifest range.
    declared.forEach((d, i) => {
      const id = lookup(d.name, d.constraint);
      direct[i]!.id = id;
      if (!id && !/^(workspace|link|file|portal):/.test(d.constraint)) {
        evidence.push({
          kind: "lockfile-manifest-mismatch",
          statement: `${d.name}@${d.constraint} is declared in the manifest but not in ${lockfile}; the lockfile is stale`,
          file: lockfile,
        });
      }
    });
  }
  return { packages, direct, evidence };
}
