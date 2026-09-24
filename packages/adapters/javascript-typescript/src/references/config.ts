/**
 * Config-file references (issue #132, via="config" and via="convention").
 *
 * Tooling is often referenced only by name inside a config file: tsconfig
 * `types`, ESLint `extends`/`plugins`, Babel presets, a Jest `preset`, a
 * Prettier plugin. Declarative configs (JSON, JSONC, YAML, and the matching
 * package.json keys) are parsed as data. JS/TS config files are not
 * evaluated. They're source files, so the import scanner already sees their
 * import/require calls. "Convention" usage is a tool whose own config file
 * or directory exists (for example `.husky/` means husky).
 *
 * Every reference only ever adds usage. That's the safe direction for an
 * "unused" verdict, so name normalisation errs towards more candidates.
 */
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import type { AdapterContext, Dependency, RepositoryHandle, Usage } from "@ghostdeps/core";

/** Config files larger than this are not parsed. */
export const MAX_CONFIG_BYTES = 256 * 1024;
/** Names collected per config section. */
const MAX_NAMES = 2_000;

type Via = "config" | "convention";

/** One package-name reference found in a config file. */
export interface ConfigReference {
  /** Candidate npm package names this reference may mean (all are credited). */
  packages: string[];
  file: string;
  line: number;
  via: Via;
  /** What referenced it, e.g. "eslint plugins" or "tsconfig types". */
  source: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Strings from a string, or from an array of strings / [name, options] tuples. */
function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const out: string[] = [];
  for (const item of list.slice(0, MAX_NAMES)) {
    if (typeof item === "string") out.push(item);
    else if (Array.isArray(item) && typeof item[0] === "string") out.push(item[0]);
  }
  return out;
}

/** "@scope/pkg/sub/path" -> "@scope/pkg"; "pkg/sub" -> "pkg"; relative/absolute/scheme paths -> undefined. */
export function packageOf(spec: string): string | undefined {
  const s = spec.trim();
  if (!s || s.startsWith(".") || s.startsWith("/") || s.includes(":") || s.startsWith("<")) {
    return undefined;
  }
  const parts = s.split("/");
  if (s.startsWith("@"))
    return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0] || undefined;
}

const pkgOnly = (n: string): string[] => {
  const p = packageOf(n);
  return p ? [p] : [];
};

/**
 * Tool shorthand -> candidate packages, following ESLint/Babel/stylelint
 * naming rules (prefix "eslint-plugin" shown):
 *   "react"      -> react, eslint-plugin-react
 *   "@scope"     -> @scope/eslint-plugin
 *   "@scope/foo" -> @scope/foo, @scope/eslint-plugin-foo
 *   "@babel/env" -> @babel/env, @babel/babel-preset-env, @babel/preset-env
 */
export function expandShorthand(name: string, prefix: string): string[] {
  const out = new Set<string>();
  const raw = name.replace(/^module:/, "");
  const pkg = packageOf(raw);
  if (pkg) out.add(pkg);
  if (raw.startsWith("@")) {
    const [scope, rest] = raw.split("/", 2) as [string, string | undefined];
    if (!rest) out.add(`${scope}/${prefix}`);
    else if (!rest.startsWith(prefix)) out.add(`${scope}/${prefix}-${rest}`);
    const short = prefix.replace(/^babel-/, "");
    if (rest && scope === "@babel" && !rest.startsWith(short)) out.add(`@babel/${short}-${rest}`);
  } else if (pkg && !pkg.startsWith(prefix)) {
    out.add(`${prefix}-${pkg}`);
  }
  return [...out];
}

function lineOf(text: string, needle: string): number {
  let at = text.indexOf(JSON.stringify(needle));
  if (at < 0) at = text.indexOf(needle);
  if (at < 0) return 1;
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

type Collector = (source: string, rawNames: string[], expand: (n: string) => string[]) => void;

function eslintConfig(doc: Record<string, unknown>, add: Collector, depth = 0): void {
  add(
    "eslint extends",
    names(own(doc, "extends")).filter((n) => !n.startsWith("eslint:")),
    (n) => {
      const m = /^plugin:((?:@[^/]+\/)?[^/]+)/.exec(n);
      if (m) return expandShorthand(m[1]!, "eslint-plugin");
      return expandShorthand(n, "eslint-config");
    },
  );
  add("eslint plugins", names(own(doc, "plugins")), (n) => expandShorthand(n, "eslint-plugin"));
  add("eslint parser", names(own(doc, "parser")), pkgOnly);
  const overrides = own(doc, "overrides");
  if (depth < 4 && Array.isArray(overrides)) {
    for (const o of overrides.slice(0, 200)) if (isRecord(o)) eslintConfig(o, add, depth + 1);
  }
}

function babelConfig(doc: Record<string, unknown>, add: Collector, depth = 0): void {
  add("babel presets", names(own(doc, "presets")), (n) => expandShorthand(n, "babel-preset"));
  add("babel plugins", names(own(doc, "plugins")), (n) => expandShorthand(n, "babel-plugin"));
  const env = own(doc, "env");
  if (depth < 4 && isRecord(env)) {
    for (const v of Object.values(env).slice(0, 50))
      if (isRecord(v)) babelConfig(v, add, depth + 1);
  }
}

const JEST_LIST_KEYS = [
  "setupFiles",
  "setupFilesAfterEnv",
  "snapshotSerializers",
  "reporters",
  "watchPlugins",
] as const;

function jestConfig(doc: Record<string, unknown>, add: Collector): void {
  add("jest preset", names(own(doc, "preset")), pkgOnly);
  add(
    "jest testEnvironment",
    names(own(doc, "testEnvironment")).filter((n) => n !== "node"),
    (n) => expandShorthand(n, "jest-environment"),
  );
  add("jest runner", [...names(own(doc, "runner")), ...names(own(doc, "testRunner"))], (n) =>
    expandShorthand(n, "jest-runner"),
  );
  const transform = own(doc, "transform");
  if (isRecord(transform)) add("jest transform", names(Object.values(transform)), pkgOnly);
  for (const key of JEST_LIST_KEYS) {
    add(
      `jest ${key}`,
      names(own(doc, key)).filter((n) => n !== "default"),
      pkgOnly,
    );
  }
}

function prettierConfig(doc: unknown, add: Collector): void {
  if (typeof doc === "string") add("prettier shared config", [doc], pkgOnly);
  else if (isRecord(doc)) add("prettier plugins", names(own(doc, "plugins")), pkgOnly);
}

function tsconfigConfig(doc: Record<string, unknown>, add: Collector): void {
  add("tsconfig extends", names(own(doc, "extends")), pkgOnly);
  const options = own(doc, "compilerOptions");
  if (!isRecord(options)) return;
  // types: ["node", "vitest/globals"] -> node / @types/node, vitest / @types/vitest.
  add("tsconfig types", names(own(options, "types")), (n) => {
    const p = packageOf(n);
    if (!p) return [];
    return [p, p.startsWith("@") ? `@types/${p.slice(1).replace("/", "__")}` : `@types/${p}`];
  });
  add("tsconfig jsxImportSource", names(own(options, "jsxImportSource")), pkgOnly);
  const plugins = own(options, "plugins");
  if (Array.isArray(plugins)) {
    const pluginNames = plugins
      .slice(0, 200)
      .flatMap((p) => (isRecord(p) ? names(own(p, "name")) : []));
    add("tsconfig plugins", pluginNames, pkgOnly);
  }
}

function sharedConfig(tool: string): (doc: Record<string, unknown>, add: Collector) => void {
  return (doc, add) => {
    add(`${tool} extends`, names(own(doc, "extends")), (n) => expandShorthand(n, `${tool}-config`));
    add(`${tool} plugins`, names(own(doc, "plugins")), (n) => expandShorthand(n, `${tool}-plugin`));
  };
}

function postcssConfig(doc: Record<string, unknown>, add: Collector): void {
  const plugins = own(doc, "plugins");
  add("postcss plugins", isRecord(plugins) ? Object.keys(plugins) : names(plugins), pkgOnly);
}

type Handler = (doc: unknown, add: Collector) => void;
const asRecord =
  (fn: (d: Record<string, unknown>, add: Collector) => void): Handler =>
  (d, add) => {
    if (isRecord(d)) fn(d, add);
  };

const ESLINT = asRecord((d, a) => eslintConfig(d, a));
const BABEL = asRecord((d, a) => babelConfig(d, a));
const JEST = asRecord(jestConfig);
const TSCONFIG = asRecord(tsconfigConfig);
const STYLELINT = asRecord(sharedConfig("stylelint"));
const COMMITLINT = asRecord(sharedConfig("commitlint"));
const POSTCSS = asRecord(postcssConfig);

/** Declarative config files by basename. */
const FILE_HANDLERS: ReadonlyMap<string, Handler> = new Map([
  [".eslintrc", ESLINT],
  [".eslintrc.json", ESLINT],
  [".eslintrc.yaml", ESLINT],
  [".eslintrc.yml", ESLINT],
  [".babelrc", BABEL],
  [".babelrc.json", BABEL],
  ["babel.config.json", BABEL],
  ["jest.config.json", JEST],
  [".prettierrc", prettierConfig],
  [".prettierrc.json", prettierConfig],
  [".prettierrc.yaml", prettierConfig],
  [".prettierrc.yml", prettierConfig],
  ["tsconfig.json", TSCONFIG],
  ["jsconfig.json", TSCONFIG],
  [".stylelintrc", STYLELINT],
  [".stylelintrc.json", STYLELINT],
  [".commitlintrc", COMMITLINT],
  [".commitlintrc.json", COMMITLINT],
  [".postcssrc", POSTCSS],
  [".postcssrc.json", POSTCSS],
]);

/** package.json keys that embed a tool config. */
const PACKAGE_JSON_KEYS: ReadonlyMap<string, Handler> = new Map([
  ["eslintConfig", ESLINT],
  ["babel", BABEL],
  ["jest", JEST],
  ["prettier", prettierConfig],
  ["stylelint", STYLELINT],
  ["commitlint", COMMITLINT],
  ["postcss", POSTCSS],
]);

interface Convention {
  package: string;
  files: readonly string[];
  dirs?: readonly string[];
  packageJsonKey?: string;
}

const rc = (base: string, exts: readonly string[]) => exts.map((e) => `${base}${e}`);
const JS_EXTS = [".js", ".cjs", ".mjs"] as const;

/** A tool's own config file, directory, or package.json key exists in the project. */
export const CONVENTIONS: readonly Convention[] = [
  { package: "husky", files: [], dirs: [".husky"] },
  {
    package: "lint-staged",
    files: [
      ...rc(".lintstagedrc", ["", ".json", ".yaml", ".yml", ...JS_EXTS]),
      ...rc("lint-staged.config", JS_EXTS),
    ],
    packageJsonKey: "lint-staged",
  },
  {
    package: "@commitlint/cli",
    files: [
      ...rc(".commitlintrc", ["", ".json", ".yaml", ".yml"]),
      ...rc("commitlint.config", [...JS_EXTS, ".ts"]),
    ],
    packageJsonKey: "commitlint",
  },
  {
    package: "eslint",
    files: [
      ...rc(".eslintrc", ["", ".json", ".yaml", ".yml", ".js", ".cjs"]),
      ...rc("eslint.config", [...JS_EXTS, ".ts"]),
    ],
    packageJsonKey: "eslintConfig",
  },
  {
    package: "prettier",
    files: [
      ...rc(".prettierrc", ["", ".json", ".yaml", ".yml", ...JS_EXTS]),
      ...rc("prettier.config", JS_EXTS),
    ],
    packageJsonKey: "prettier",
  },
  {
    package: "jest",
    files: rc("jest.config", [...JS_EXTS, ".ts", ".json"]),
    packageJsonKey: "jest",
  },
  {
    package: "@babel/core",
    files: [...rc(".babelrc", ["", ".json"]), ...rc("babel.config", [...JS_EXTS, ".json"])],
    packageJsonKey: "babel",
  },
  { package: "tailwindcss", files: rc("tailwind.config", [...JS_EXTS, ".ts"]) },
  {
    package: "postcss",
    files: [...rc(".postcssrc", ["", ".json"]), ...rc("postcss.config", JS_EXTS)],
    packageJsonKey: "postcss",
  },
  {
    package: "stylelint",
    files: [...rc(".stylelintrc", ["", ".json"]), ...rc("stylelint.config", JS_EXTS)],
    packageJsonKey: "stylelint",
  },
  { package: "typescript", files: ["tsconfig.json"] },
];

function parseText(file: string, text: string): unknown {
  if (file.endsWith(".yaml") || file.endsWith(".yml")) {
    return parseYaml(text, { maxAliasCount: 100, uniqueKeys: true });
  }
  // JSON with comments/trailing commas. Extension-less rc files may be YAML.
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  if (!error) return config;
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (!base.includes(".json")) return parseYaml(text, { maxAliasCount: 100, uniqueKeys: true });
  throw new Error("malformed");
}

type ReadResult = { text: string } | { reason: string };

async function readText(repository: RepositoryHandle, file: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await repository.readFile(file);
  } catch {
    return { reason: "unreadable" };
  }
  return Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES ? { reason: "oversized" } : { text };
}

/** A config file that exists but whose references could not be read. */
export interface UnreadConfig {
  file: string;
  reason: "unreadable" | "oversized" | "malformed" | "not evaluated";
}

/** Everything the config scan found for one project, plus what it could not read. */
export interface ConfigScan {
  refs: ConfigReference[];
  /** Non-empty means config coverage is incomplete: no "unused" verdict may rely on it. */
  unread: UnreadConfig[];
}

/** JS/TS tool configs are source files and are never evaluated. */
const EXECUTABLE_CONFIG = /^(?:[^/]+\.config|\.[a-z-]+rc)\.(?:c|m)?[jt]s$/;

/** Every config/convention reference directly inside one directory. */
async function collectDirectory(
  repository: RepositoryHandle,
  projectDir: string,
  files: readonly string[],
): Promise<ConfigScan> {
  const prefix = projectDir === "." ? "" : `${projectDir}/`;
  const inProject = new Set(
    files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)),
  );
  const refs: ConfigReference[] = [];
  const unread: UnreadConfig[] = [];
  const collector =
    (file: string, text: string): Collector =>
    (source, rawNames, expand) => {
      for (const raw of rawNames.slice(0, MAX_NAMES)) {
        const packages = expand(raw);
        if (packages.length)
          refs.push({ packages, file, line: lineOf(text, raw), via: "config", source });
      }
    };

  for (const [base, handler] of FILE_HANDLERS) {
    if (!inProject.has(base)) continue;
    const file = `${prefix}${base}`;
    const read = await readText(repository, file);
    if (!("text" in read)) {
      unread.push({ file, reason: read.reason as UnreadConfig["reason"] });
      continue;
    }
    try {
      handler(parseText(file, read.text), collector(file, read.text));
    } catch {
      // No references from a malformed config, and coverage is no longer complete.
      unread.push({ file, reason: "malformed" });
    }
  }
  for (const f of inProject) {
    if (!f.includes("/") && EXECUTABLE_CONFIG.test(f)) {
      unread.push({ file: `${prefix}${f}`, reason: "not evaluated" });
    }
  }

  const manifestFile = `${prefix}package.json`;
  let manifestText: string | undefined;
  let manifest: Record<string, unknown> | undefined;
  if (inProject.has("package.json")) {
    const read = await readText(repository, manifestFile);
    if ("text" in read) {
      manifestText = read.text;
      try {
        const doc: unknown = JSON.parse(read.text);
        if (isRecord(doc)) manifest = doc;
      } catch {
        manifest = undefined;
      }
      if (!manifest) unread.push({ file: manifestFile, reason: "malformed" });
    } else {
      unread.push({ file: manifestFile, reason: read.reason as UnreadConfig["reason"] });
    }
  }
  if (manifest && manifestText !== undefined) {
    for (const [key, handler] of PACKAGE_JSON_KEYS) {
      const value = own(manifest, key);
      if (value !== undefined) handler(value, collector(manifestFile, manifestText));
    }
  }

  const topDirs = new Set<string>();
  for (const f of inProject) {
    const i = f.indexOf("/");
    if (i > 0) topDirs.add(f.slice(0, i));
  }
  for (const c of CONVENTIONS) {
    const file = c.files.find((f) => inProject.has(f));
    const dir = c.dirs?.find((d) => topDirs.has(d));
    if (file !== undefined) {
      refs.push({
        packages: [c.package],
        file: `${prefix}${file}`,
        line: 1,
        via: "convention",
        source: `${file} present`,
      });
    } else if (dir !== undefined) {
      const inside = [...inProject].find((f) => f.startsWith(`${dir}/`)) ?? dir;
      refs.push({
        packages: [c.package],
        file: `${prefix}${inside}`,
        line: 1,
        via: "convention",
        source: `${dir}/ present`,
      });
    } else if (
      c.packageJsonKey &&
      manifest &&
      manifestText !== undefined &&
      Object.hasOwn(manifest, c.packageJsonKey)
    ) {
      refs.push({
        packages: [c.package],
        file: manifestFile,
        line: lineOf(manifestText, c.packageJsonKey),
        via: "convention",
        source: `package.json "${c.packageJsonKey}" present`,
      });
    }
  }
  return { refs, unread };
}

/**
 * Config references for one project. Workspace members also inherit the
 * repository root's configs (a root ESLint or Babel config applies to them),
 * so the root's references credit the member and the root's unread configs
 * make the member's coverage incomplete too.
 */
export async function collectConfigReferences(
  repository: RepositoryHandle,
  projectDir: string,
  files: readonly string[],
): Promise<ConfigScan> {
  const own = await collectDirectory(repository, projectDir, files);
  if (projectDir === ".") return own;
  const root = await collectDirectory(repository, ".", files);
  return { refs: [...own.refs, ...root.refs], unread: [...own.unread, ...root.unread] };
}

const cache = new WeakMap<AdapterContext, Map<string, Promise<ConfigScan>>>();

function scanFor(context: AdapterContext, dependency: Dependency): Promise<ConfigScan> {
  const projectDir = dependency.project.path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  let perProject = cache.get(context);
  if (!perProject) {
    perProject = new Map();
    cache.set(context, perProject);
  }
  let pending = perProject.get(projectDir);
  if (!pending) {
    pending = (async () => {
      const files = (await context.repository.listFiles()).map((f) => f.replace(/^\.\//, ""));
      return collectConfigReferences(context.repository, projectDir, files);
    })();
    perProject.set(projectDir, pending);
  }
  return pending;
}

/** via="config" / via="convention" usages of `dependency` from its project's (and the root's) configs. */
export async function findConfigUsages(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const { refs } = await scanFor(context, dependency);
  return refs
    .filter((r) => r.packages.includes(dependency.name))
    .map((r) => ({
      dependency: dependency.name,
      file: r.file,
      line: r.line,
      form: "unknown" as const,
      via: r.via,
      symbols: [r.source],
    }));
}

/** Config files for `dependency`'s project that exist but could not be read. Empty = complete coverage. */
export async function unreadConfigs(
  context: AdapterContext,
  dependency: Dependency,
): Promise<UnreadConfig[]> {
  return (await scanFor(context, dependency)).unread;
}
