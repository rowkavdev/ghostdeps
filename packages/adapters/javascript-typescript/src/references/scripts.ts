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

/**
 * How a wrapper takes its own flags. `value` flags consume the next word,
 * `exec` flags take a command string, `bool` flags stand alone. A flag not
 * listed makes the script "not fully analysed" (we can't know whether it
 * swallows the next word).
 */
interface WrapperSpec {
  /** true when the wrapper is itself a dependency (credited as a word). */
  isPackage: boolean;
  value?: readonly string[];
  exec?: readonly string[];
  bool?: readonly string[];
}

/** Runners and wrapper CLIs whose next command word is the bin. */
const WRAPPER_SPECS: Readonly<Record<string, WrapperSpec>> = Object.freeze({
  npx: {
    isPackage: false,
    value: ["-p", "--package"],
    exec: ["-c", "--call"],
    bool: ["-y", "--yes", "--no", "-q", "--quiet", "--no-install", "--ignore-existing"],
  },
  pnpx: { isPackage: false, value: ["-p", "--package"], bool: ["-y", "--yes"] },
  bunx: { isPackage: false, value: ["-p", "--package"], bool: ["--bun", "--silent"] },
  env: {
    isPackage: false,
    value: ["-u", "--unset", "-C", "--chdir"],
    exec: ["-S", "--split-string"],
    bool: ["-i", "--ignore-environment", "-0", "--null"],
  },
  time: { isPackage: false, value: ["-f", "--format", "-o", "--output"], bool: ["-p", "-v"] },
  nice: { isPackage: false, value: ["-n", "--adjustment"] },
  exec: { isPackage: false, value: ["-a"], bool: ["-c", "-l"] },
  "cross-env": { isPackage: true },
  "cross-env-shell": { isPackage: true },
  dotenv: { isPackage: true, value: ["-e", "-v", "-c", "-p"], bool: ["-o", "--debug"] },
  nodemon: {
    isPackage: true,
    value: [
      "-w",
      "--watch",
      "-e",
      "--ext",
      "-i",
      "--ignore",
      "-d",
      "--delay",
      "-s",
      "--signal",
      "--config",
      "--cwd",
    ],
    exec: ["-x", "--exec"],
    bool: [
      "-q",
      "--quiet",
      "-V",
      "--verbose",
      "-L",
      "--legacy-watch",
      "-I",
      "--no-stdin",
      "--no-colors",
      "--spawn",
      "-C",
      "--on-change-only",
      "--dump",
    ],
  },
});
/** Shells: `sh -c "<command>"` is analysed; `sh file.sh` runs a file we don't read. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** Package-manager subcommands that run a bin: `pnpm exec x`, `yarn dlx x`, `bun x x`, `npm exec x`. */
const PM_EXEC = new Set(["exec", "dlx", "x"]);
const PMS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Package-manager global flags that take a value (`pnpm --filter web exec tsc`). */
const PM_VALUE_FLAGS = new Set([
  "--filter",
  "-F",
  "-C",
  "--dir",
  "--prefix",
  "--cwd",
  "--workspace",
]);
/** Nested `sh -c` / `--exec` command strings analysed before giving up. */
const MAX_NESTING = 3;
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

/** Result of reading one script as text. */
export interface ScriptAnalysis {
  /** Words in command position, e.g. "tsc -p . && vitest run" -> ["tsc", "vitest"]. */
  words: string[];
  /** Why some of the script could not be read; empty means every command was analysed. */
  gaps: string[];
}

/** Split a script into command segments of words, honouring quotes. Never evaluates anything. */
function tokenise(text: string, gaps: string[]): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const close = c === "'" ? text.indexOf("'", i + 1) : closingDoubleQuote(text, i + 1);
      if (close < 0) {
        gaps.push("unbalanced quote");
        break;
      }
      const inner = text.slice(i + 1, close);
      word += c === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
      inWord = true;
      if (c === '"' && /\$\(|`/.test(inner)) gaps.push("command substitution");
      i = close;
    } else if (c === "\\") {
      word += text[i + 1] ?? "";
      inWord = true;
      i++;
    } else if (c === "$" && text[i + 1] === "(") {
      gaps.push("command substitution");
      endSegment();
      i++;
    } else if (c === "`") {
      gaps.push("command substitution");
      endSegment();
    } else if (/[;|&\n()]/.test(c)) {
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

function closingDoubleQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
const bareCommand = (w: string) => w.replace(/^(\.\/)?node_modules\/\.bin\//, "");

function analyseInto(script: string, depth: number, out: ScriptAnalysis): void {
  if (script.length > MAX_SCRIPT_LENGTH) out.gaps.push("script too long");
  for (const words of tokenise(script.slice(0, MAX_SCRIPT_LENGTH), out.gaps)) {
    analyseSegment(words, depth, out);
  }
}

function analyseNested(command: string | undefined, depth: number, out: ScriptAnalysis): void {
  if (command === undefined) return;
  if (depth >= MAX_NESTING) out.gaps.push("nested command too deep");
  else analyseInto(command, depth + 1, out);
}

function analyseSegment(words: string[], depth: number, out: ScriptAnalysis): void {
  let i = 0;
  for (;;) {
    while (i < words.length && (isAssignment(words[i]!) || words[i] === "--")) i++;
    // Flags before any command (rare) are skipped.
    while (i < words.length && words[i]!.startsWith("-")) i++;
    const word = words[i];
    if (word === undefined) return;
    const bare = bareCommand(word);
    const spec = Object.hasOwn(WRAPPER_SPECS, bare) ? WRAPPER_SPECS[bare] : undefined;
    if (spec) {
      if (spec.isPackage) out.words.push(bare);
      i++;
      while (i < words.length && words[i]!.startsWith("-")) {
        const raw = words[i]!;
        if (raw === "--") {
          i++;
          break;
        }
        const eq = raw.indexOf("=");
        const flag = eq > 0 ? raw.slice(0, eq) : raw;
        const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
        if (spec.exec?.includes(flag)) {
          analyseNested(inline ?? words[i + 1], depth, out);
          return;
        }
        if (spec.value?.includes(flag)) i += inline === undefined ? 2 : 1;
        else {
          if (!spec.bool?.includes(flag)) out.gaps.push(`${bare}: unrecognised flag ${flag}`);
          i++;
        }
      }
      continue;
    }
    if (SHELLS.has(bare)) {
      let j = i + 1;
      while (j < words.length && words[j]!.startsWith("-") && words[j] !== "-c") j++;
      if (words[j] === "-c") analyseNested(words[j + 1], depth, out);
      else if (words[j] !== undefined) out.gaps.push(`${bare} runs ${words[j]}, which is not read`);
      return;
    }
    if (bare === "eval") {
      out.gaps.push("eval");
      return;
    }
    if (bare === "node") {
      const rest = words.slice(i + 1);
      if (rest.some((w) => w === "-e" || w === "--eval" || w === "-p" || w === "--print")) {
        out.gaps.push("node evaluates inline code");
      } else {
        // The file's imports are in the source scan, but bins it spawns
        // (execSync("tsc")) are not, so a node script is a coverage gap.
        const file = rest.find((w) => !w.startsWith("-"));
        if (file !== undefined) out.gaps.push(`node runs ${file}; commands it spawns are not read`);
      }
      return;
    }
    if (PMS.has(bare)) {
      let j = i + 1;
      while (j < words.length && words[j]!.startsWith("-")) {
        j += PM_VALUE_FLAGS.has(words[j]!) ? 2 : 1;
      }
      const sub = words[j];
      if (sub !== undefined && PM_EXEC.has(sub)) {
        i = j + 1;
        continue;
      }
      // `yarn tsc` / `pnpm vitest` run a bin directly; `npm` never does.
      if (bare !== "npm" && sub !== undefined && !PM_BUILTINS.has(sub)) out.words.push(sub);
      return;
    }
    out.words.push(bare);
    return;
  }
}

/** Read one script as text: command words plus anything that could not be analysed. */
export function analyseScript(script: string): ScriptAnalysis {
  const out: ScriptAnalysis = { words: [], gaps: [] };
  analyseInto(script, 0, out);
  return out;
}

/** Words in command position across one script, e.g. "tsc -p . && vitest run" -> ["tsc", "vitest"]. */
export function commandWords(script: string): string[] {
  return analyseScript(script).words;
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
  /** More than MAX_SCRIPTS scripts: the rest were not read. */
  truncated: boolean;
}

type ManifestRead = ManifestScripts | { file: string; problem: string } | undefined;

async function readScripts(
  repository: RepositoryHandle,
  projectDir: string,
): Promise<ManifestRead> {
  const file = projectDir === "." ? "package.json" : `${projectDir}/package.json`;
  if (!(await repository.exists(file))) return undefined;
  let text: string;
  try {
    text = await repository.readFile(file);
  } catch {
    return { file, problem: "unreadable" };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_READ_BYTES) return { file, problem: "oversized" };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { file, problem: "malformed" };
  }
  if (!isRecord(doc)) return { file, problem: "malformed" };
  if (!Object.hasOwn(doc, "scripts") || !isRecord(doc.scripts)) {
    return { file, text, scripts: [], truncated: false };
  }
  const entries = Object.entries(doc.scripts);
  const scripts: [string, string][] = [];
  for (const [name, value] of entries.slice(0, MAX_SCRIPTS)) {
    if (typeof value === "string") scripts.push([name, value]);
  }
  return { file, text, scripts, truncated: entries.length > MAX_SCRIPTS };
}

const manifestCaches = new WeakMap<AdapterContext, Map<string, Promise<ManifestRead>>>();

function projectDirOf(dependency: Dependency): string {
  return dependency.project.path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
}

/** The project's package.json scripts, read once per analysis run. */
function manifestFor(context: AdapterContext, projectDir: string): Promise<ManifestRead> {
  let cache = manifestCaches.get(context);
  if (!cache) {
    cache = new Map();
    manifestCaches.set(context, cache);
  }
  let pending = cache.get(projectDir);
  if (!pending) {
    pending = readScripts(context.repository, projectDir);
    cache.set(projectDir, pending);
  }
  return pending;
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
  const projectDir = projectDirOf(dependency);
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

/** The dependency's own manifest, then (for workspace members) the root's, which runs member tooling too. */
async function manifestsFor(
  context: AdapterContext,
  dependency: Dependency,
): Promise<ManifestRead[]> {
  const projectDir = projectDirOf(dependency);
  const own = await manifestFor(context, projectDir);
  return projectDir === "." ? [own] : [own, await manifestFor(context, ".")];
}

/** via="script" usages of `dependency` in its project's (and the root's) package.json scripts. */
export async function findScriptUsages(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const manifests = (await manifestsFor(context, dependency)).filter(
    (m): m is ManifestScripts => m !== undefined && "scripts" in m && m.scripts.length > 0,
  );
  if (manifests.length === 0) return [];
  const bins = await binNames(context, dependency);
  if (bins.size === 0) return [];
  const usages: Usage[] = [];
  for (const manifest of manifests) {
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
  }
  return usages;
}

const gapCaches = new WeakMap<ManifestScripts, string[]>();

function manifestGaps(manifest: ManifestRead): string[] {
  if (!manifest) return [];
  if (!("scripts" in manifest)) return [`${manifest.file}: ${manifest.problem}`];
  const cached = gapCaches.get(manifest);
  if (cached) return cached;
  const gaps: string[] = [];
  if (manifest.truncated) gaps.push(`${manifest.file}: more than ${MAX_SCRIPTS} scripts`);
  for (const [name, command] of manifest.scripts) {
    for (const gap of new Set(analyseScript(command).gaps)) {
      gaps.push(`${manifest.file} script "${name}": ${gap}`);
    }
  }
  gapCaches.set(manifest, gaps);
  return gaps;
}

/**
 * Why the project's scripts (and, for workspace members, the root's) were
 * not fully analysed: unreadable manifest, too many scripts, an unrecognised
 * wrapper flag, a shell or node file, eval, ... Empty means every script was
 * read. Feeds referenceAnalysisComplete (#132).
 */
export async function scriptGaps(
  context: AdapterContext,
  dependency: Dependency,
): Promise<string[]> {
  return (await manifestsFor(context, dependency)).flatMap(manifestGaps);
}
