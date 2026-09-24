/**
 * package.json script references (issue #132, via="script").
 *
 * A dependency used only as a CLI (tsc, eslint, vitest) never appears in an
 * import, so without this it looks unused. Scripts are read as text and
 * tokenised: nothing is run, no shell is involved, and no PATH or
 * node_modules/.bin lookup happens. Bin names come from the npm lockfile
 * when it records them, plus the package's own name and a small table of
 * well-known names that differ (typescript -> tsc).
 */
import { MAX_FILE_READ_BYTES, MAX_LOCKFILE_BYTES } from "@ghostdeps/core";
import type { AdapterContext, Dependency, RepositoryHandle, Usage } from "@ghostdeps/core";

/** Scripts read per manifest; beyond this the rest are ignored. */
export const MAX_SCRIPTS = 1_000;
/** Characters of one script command that are tokenised. */
export const MAX_SCRIPT_LENGTH = 8_192;

/**
 * Well-known packages whose bin name differs from the package name. Data,
 * not logic. The lockfile is preferred when it records `bin`.
 */
export const KNOWN_BINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  typescript: ["tsc", "tsserver"],
  "@biomejs/biome": ["biome"],
  "@angular/cli": ["ng"],
  "@nestjs/cli": ["nest"],
  "@vue/cli-service": ["vue-cli-service"],
  "@playwright/test": ["playwright"],
  "@changesets/cli": ["changeset", "changesets"],
  "@storybook/cli": ["sb", "storybook"],
  "npm-run-all": ["npm-run-all", "run-s", "run-p"],
  "npm-run-all2": ["npm-run-all", "run-s", "run-p"],
  concurrently: ["concurrently", "conc"],
  "@swc/cli": ["swc", "spack"],
  "@babel/cli": ["babel", "babel-external-helpers"],
  "@microsoft/api-extractor": ["api-extractor"],
  "ts-node": ["ts-node", "ts-node-esm", "ts-node-script", "ts-node-transpile-only"],
  "@commitlint/cli": ["commitlint"],
  "webpack-cli": ["webpack-cli", "webpack"],
});

/** Runners whose next command word is the bin (they are not dependencies themselves). */
const RUNNERS = new Set(["npx", "pnpx", "bunx", "env", "time", "nice", "exec"]);
/** Wrapper CLIs that are dependencies themselves and also run the next command word. */
const WRAPPERS = new Set(["cross-env", "cross-env-shell", "dotenv", "nodemon"]);
/** Package-manager subcommands that run a bin: `pnpm exec x`, `yarn dlx x`, `bun x x`, `npm exec x`. */
const PM_EXEC = new Set(["exec", "dlx", "x"]);
const PMS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Package-manager subcommands that are not bins (`yarn install`, `pnpm run build`). */
const PM_BUILTINS = new Set([
  "run",
  "run-script",
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "ci",
  "test",
  "t",
  "start",
  "stop",
  "restart",
  "build",
  "publish",
  "pack",
  "version",
  "init",
  "create",
  "link",
  "unlink",
  "update",
  "up",
  "upgrade",
  "outdated",
  "audit",
  "why",
  "info",
  "view",
  "config",
  "set",
  "workspace",
  "workspaces",
  "-w",
  "--filter",
  "-F",
  "recursive",
  "-r",
  "import",
  "rebuild",
  "prune",
  "dedupe",
  "store",
  "cache",
  "login",
  "logout",
  "whoami",
  "help",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const unscoped = (name: string) => (name.startsWith("@") ? (name.split("/")[1] ?? name) : name);

/** Words in command position across one script, e.g. "tsc -p . && vitest run" -> ["tsc", "vitest"]. */
export function commandWords(script: string): string[] {
  const out: string[] = [];
  const text = script.slice(0, MAX_SCRIPT_LENGTH);
  for (const segment of text.split(/&&|\|\||[;|&\n()]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    for (;;) {
      // Skip env assignments (FOO=bar) and flags before the command.
      while (
        i < words.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || words[i]!.startsWith("-"))
      )
        i++;
      const word = words[i];
      if (word === undefined) break;
      const bare = word.replace(/^["']|["']$/g, "").replace(/^(\.\/)?node_modules\/\.bin\//, "");
      if (RUNNERS.has(bare) || WRAPPERS.has(bare)) {
        if (WRAPPERS.has(bare)) out.push(bare);
        i++;
        continue;
      }
      if (PMS.has(bare)) {
        const sub = words[i + 1];
        if (sub !== undefined && PM_EXEC.has(sub)) {
          i += 2;
          continue;
        }
        // `yarn tsc` / `pnpm vitest` run a bin directly; `npm` never does.
        if (bare !== "npm" && sub !== undefined && !sub.startsWith("-") && !PM_BUILTINS.has(sub)) {
          out.push(sub);
        }
        break;
      }
      out.push(bare);
      break;
    }
  }
  return out;
}

/** 1-based line of `"name":` inside the "scripts" object, falling back to the "scripts" key line. */
function scriptLine(text: string, name: string): number {
  const scriptsAt = text.indexOf('"scripts"');
  const from = scriptsAt < 0 ? 0 : scriptsAt;
  const needle = `${JSON.stringify(name)}`;
  let at = text.indexOf(needle, from + 1);
  if (at < 0) at = from;
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

interface ManifestScripts {
  file: string;
  text: string;
  scripts: [string, string][];
}

async function readScripts(
  repository: RepositoryHandle,
  projectDir: string,
): Promise<ManifestScripts | undefined> {
  const file = projectDir === "." ? "package.json" : `${projectDir}/package.json`;
  let text: string;
  try {
    text = await repository.readFile(file);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_READ_BYTES) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(doc) || !Object.hasOwn(doc, "scripts") || !isRecord(doc.scripts)) {
    return { file, text, scripts: [] };
  }
  const scripts: [string, string][] = [];
  for (const [name, value] of Object.entries(doc.scripts).slice(0, MAX_SCRIPTS)) {
    if (typeof value === "string") scripts.push([name, value]);
  }
  return { file, text, scripts };
}

/** Bin names npm's lockfile records for `name` as seen from `projectDir`, or undefined when unknown. */
async function lockfileBins(
  repository: RepositoryHandle,
  projectDir: string,
  name: string,
  cache: Map<string, Promise<Record<string, unknown> | undefined>>,
): Promise<string[] | undefined> {
  for (let dir = projectDir; ;) {
    for (const lock of ["npm-shrinkwrap.json", "package-lock.json"]) {
      const file = dir === "." ? lock : `${dir}/${lock}`;
      if (!(await repository.exists(file))) continue;
      let pending = cache.get(file);
      if (!pending) {
        pending = (async () => {
          try {
            const text = await repository.readFile(file);
            if (Buffer.byteLength(text, "utf8") > MAX_LOCKFILE_BYTES) return undefined;
            const doc: unknown = JSON.parse(text);
            return isRecord(doc) && isRecord(doc.packages) ? doc.packages : undefined;
          } catch {
            return undefined;
          }
        })();
        cache.set(file, pending);
      }
      const packages = await pending;
      if (!packages) return undefined;
      const rel = dir === "." ? projectDir : projectDir.slice(dir.length + 1);
      const keys = [
        rel && rel !== "." ? `${rel}/node_modules/${name}` : "",
        `node_modules/${name}`,
      ].filter(Boolean);
      for (const key of keys) {
        const entry = Object.hasOwn(packages, key) ? packages[key] : undefined;
        if (!isRecord(entry)) continue;
        const bin = Object.hasOwn(entry, "bin") ? entry.bin : undefined;
        if (typeof bin === "string") return [unscoped(name)];
        if (isRecord(bin)) return Object.keys(bin);
        return [];
      }
      return undefined;
    }
    if (dir === ".") return undefined;
    const i = dir.lastIndexOf("/");
    dir = i < 0 ? "." : dir.slice(0, i);
  }
}

const lockCaches = new WeakMap<
  AdapterContext,
  Map<string, Promise<Record<string, unknown> | undefined>>
>();

/** Candidate bin names for a dependency: lockfile `bin` when recorded, else the known table and its own name. */
export async function binNames(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Set<string>> {
  let cache = lockCaches.get(context);
  if (!cache) {
    cache = new Map();
    lockCaches.set(context, cache);
  }
  const projectDir = dependency.project.path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const names = new Set<string>();
  const fromLock = await lockfileBins(context.repository, projectDir, dependency.name, cache);
  for (const n of fromLock ?? []) names.add(n);
  const known = Object.hasOwn(KNOWN_BINS, dependency.name)
    ? KNOWN_BINS[dependency.name]
    : undefined;
  for (const n of known ?? []) names.add(n);
  // Most CLIs are named after their package. Only fall back to that when the lockfile doesn't say otherwise.
  if (fromLock === undefined) names.add(unscoped(dependency.name));
  return names;
}

/** via="script" usages of `dependency` in its project's package.json scripts. */
export async function findScriptUsages(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const projectDir = dependency.project.path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const manifest = await readScripts(context.repository, projectDir);
  if (!manifest || manifest.scripts.length === 0) return [];
  const bins = await binNames(context, dependency);
  if (bins.size === 0) return [];
  const usages: Usage[] = [];
  for (const [name, command] of manifest.scripts) {
    const hits = [...new Set(commandWords(command).filter((w) => bins.has(w)))];
    if (hits.length === 0) continue;
    usages.push({
      dependency: dependency.name,
      file: manifest.file,
      line: scriptLine(manifest.text, name),
      form: "unknown",
      via: "script",
      symbols: hits,
    });
  }
  return usages;
}
