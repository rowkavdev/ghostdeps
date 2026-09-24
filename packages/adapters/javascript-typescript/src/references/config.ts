/**
 * Config-file references (issue #132, via="config" and via="convention").
 *
 * Tooling is often referenced only by name inside a config file: tsconfig
 * `types`, ESLint `extends`/`plugins`, Babel presets, a Jest `preset`, a
 * Prettier plugin. Declarative configs (JSON, JSONC, YAML, and the matching
 * package.json keys) are parsed as data. JS/TS config files are parsed,
 * never evaluated (#149): their string literals are credited and the import
 * scanner sees their import/require calls. "Convention" usage is a tool whose own config file
 * or directory exists (for example `.husky/` means husky).
 *
 * Every reference only ever adds usage. That's the safe direction for an
 * "unused" verdict, so name normalisation errs towards more candidates.
 */
import { isBuiltin } from "node:module";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import type { AdapterContext, Dependency, RepositoryHandle, Usage } from "@ghostdeps/core";
import { buildLockfileGraph } from "../lockfile/build.js";

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
  /** Package-name prefixes also credited (tools that auto-discover plugins: "@size-limit/"). */
  prefixes?: string[];
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
  /** Declared packages with this prefix are also credited: the tool loads them by discovery. */
  creditPrefix?: string;
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
  // size-limit loads every installed @size-limit/* preset or plugin by discovery.
  {
    package: "size-limit",
    files: rc(".size-limit", [".json", ...JS_EXTS, ".ts"]),
    packageJsonKey: "size-limit",
    creditPrefix: "@size-limit/",
  },
  {
    package: "simple-git-hooks",
    files: [
      ...rc(".simple-git-hooks", [".json", ...JS_EXTS]),
      ...rc("simple-git-hooks", [".json", ...JS_EXTS]),
    ],
    packageJsonKey: "simple-git-hooks",
  },
  {
    package: "nano-staged",
    files: rc(".nano-staged", [".json", ...JS_EXTS]),
    packageJsonKey: "nano-staged",
  },
  { package: "c8", files: rc(".c8rc", ["", ".json"]), packageJsonKey: "c8" },
  { package: "nyc", files: rc(".nycrc", ["", ".json", ".yaml", ".yml"]), packageJsonKey: "nyc" },
  { package: "ava", files: rc("ava.config", JS_EXTS), packageJsonKey: "ava" },
  { package: "xo", files: rc("xo.config", [...JS_EXTS, ".ts"]), packageJsonKey: "xo" },
  {
    package: "mocha",
    files: rc(".mocharc", [".json", ".jsonc", ".yaml", ".yml", ...JS_EXTS]),
    packageJsonKey: "mocha",
  },
  {
    package: "vitest",
    files: [
      ...rc("vitest.config", [...JS_EXTS, ".ts", ".mts", ".cts"]),
      ...rc("vitest.workspace", [".json", ...JS_EXTS, ".ts"]),
    ],
  },
  { package: "vite", files: rc("vite.config", [...JS_EXTS, ".ts", ".mts", ".cts"]) },
  { package: "webpack", files: rc("webpack.config", [...JS_EXTS, ".ts"]) },
  { package: "rollup", files: rc("rollup.config", [...JS_EXTS, ".ts"]) },
  { package: "@playwright/test", files: rc("playwright.config", [...JS_EXTS, ".ts"]) },
  { package: "cypress", files: rc("cypress.config", [...JS_EXTS, ".ts"]) },
  { package: "next", files: rc("next.config", [...JS_EXTS, ".ts"]) },
  { package: "turbo", files: ["turbo.json"] },
  { package: "nx", files: ["nx.json"] },
  { package: "lerna", files: ["lerna.json"] },
  { package: "@changesets/cli", files: [], dirs: [".changeset"] },
  {
    package: "release-it",
    files: rc(".release-it", [".json", ".yaml", ".yml", ".toml", ...JS_EXTS, ".ts"]),
    packageJsonKey: "release-it",
  },
  {
    package: "semantic-release",
    files: rc(".releaserc", ["", ".json", ".yaml", ".yml", ...JS_EXTS]),
    packageJsonKey: "release",
  },
  { package: "typedoc", files: ["typedoc.json"] },
  {
    package: "knip",
    files: ["knip.json", "knip.jsonc", ...rc("knip.config", [...JS_EXTS, ".ts"])],
    packageJsonKey: "knip",
  },
  { package: "tsd", files: [], packageJsonKey: "tsd" },
  // tsdown loads a TypeScript config with unrun (optional peer) when the
  // runtime cannot import TypeScript natively, or with --config-loader unrun.
  { package: "unrun", files: rc("tsdown.config", [".ts", ".mts", ".cts"]) },
];

/** Tool config basenames (JS/TS) that are never evaluated, recognised at any depth. */
const KNOWN_EXECUTABLE_CONFIGS: ReadonlySet<string> = new Set(
  CONVENTIONS.flatMap((c) => c.files).filter((f) => /\.(?:c|m)?[jt]s$/.test(f)),
);

/** Declarative configs recognised below the project root (nested tsconfig, per-folder .eslintrc). */
function handlerFor(base: string): Handler | undefined {
  const direct = FILE_HANDLERS.get(base);
  if (direct) return direct;
  // tsconfig.build.json, tsconfig.test.json, ...
  if (/^tsconfig\.[^/]+\.json$/.test(base)) return TSCONFIG;
  return undefined;
}

/** Config files read per project, nested ones included. */
const MAX_CONFIG_FILES = 500;

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
  reason:
    | "unreadable"
    | "oversized"
    | "malformed"
    | "not evaluated"
    | "over limit"
    | "computed specifier"
    | "imports local module"
    | "imports shared config package";
}

/** Everything the config scan found for one project, plus what it could not read. */
export interface ConfigScan {
  refs: ConfigReference[];
  /** Non-empty means config coverage is incomplete: no "unused" verdict may rely on it. */
  unread: UnreadConfig[];
  /**
   * JS/TS configs that import a package (a shared config such as
   * "@acme/eslint-config"). That package's own references (its peers) are
   * not read, so these count as unread unless the project has a complete
   * dependency graph whose edges show those peers (#201 review).
   */
  sharedImports: string[];
}

/** JS/TS tool configs are source files and are never evaluated. */
const EXECUTABLE_CONFIG = /^(?:[^/]+\.config|\.[a-z-]+rc)\.(?:c|m)?[jt]s$/;

/** String literals credited per executable config. */
const MAX_CONFIG_STRINGS = 5_000;

/** Shorthand prefixes a tool applies to names in its own config, by config basename. */
function toolExpander(base: string): (n: string) => string[] {
  const tool = /^\.?([a-z-]+?)(?:rc|\.config)?\.(?:c|m)?[jt]s$/.exec(base)?.[1] ?? "";
  const both =
    (a: string, b: string) =>
    (n: string): string[] => {
      const m = /^plugin:((?:@[^/]+\/)?[^/]+)/.exec(n);
      const name = m ? m[1]! : n.replace(/^module:/, "");
      // Only whole names ("airbnb", "@scope", "@scope/foo"): a rule id or a
      // path ("import/no-cycle", "react/jsx-key") is not a package reference.
      if (!PACKAGE_NAME.test(name) && !/^@[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) return [];
      return [
        ...new Set([...exactName(n), ...expandShorthand(name, a), ...expandShorthand(name, b)]),
      ];
    };
  switch (tool) {
    case "eslint":
      return both("eslint-plugin", "eslint-config");
    case "babel":
      return both("babel-preset", "babel-plugin");
    case "stylelint":
      return both("stylelint-plugin", "stylelint-config");
    case "commitlint":
      return both("commitlint-plugin", "commitlint-config");
    case "jest":
      return both("jest-environment", "jest-runner");
    default:
      return exactName;
  }
}

/** A whole string that is a valid npm package name. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** The string itself, when it is a package name: exact matching, no subpath or prefix. */
const exactName = (n: string): string[] => (PACKAGE_NAME.test(n) ? [n] : []);

/** Text a string-building expression starts with, when it starts with a literal. */
function leadingLiteral(node: ts.Expression): string | undefined {
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    let left: ts.Expression = node;
    for (let i = 0; i < 1_000 && ts.isBinaryExpression(left); i++) left = left.left;
    return ts.isStringLiteralLike(left) ? left.text : undefined;
  }
  return undefined;
}

/**
 * A string built at runtime that may be a package name: its literal start is
 * itself a bare or scoped name fragment ("eslint-plugin-" + x, `@scope/${x}`).
 * Paths (`${__dirname}/src`) and prose ("Hello " + x) are not.
 */
const NAME_FRAGMENT =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*[-/]?$|^@[a-z0-9-~][a-z0-9-._~]*\/?$/i;

/**
 * Statically read one JS/TS tool config (#149). It is parsed with the
 * TypeScript parser and never evaluated. Every string literal in it becomes
 * a config reference (with the tool's shorthand expansion), since plugins and
 * presets are usually named by string. The config stays unread (coverage
 * incomplete) if it does not parse, loads a module by a non-literal
 * specifier, builds a string that may be a package name at runtime, or
 * imports a local module whose strings are not read here. Its import/require
 * calls are credited by the source scan, as before.
 */
export function readExecutableConfig(
  file: string,
  base: string,
  text: string,
): { refs: ConfigReference[]; importsPackage: boolean } | { reason: UnreadConfig["reason"] } {
  const kind = /\.(?:c|m)?ts$/.test(base) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) return { reason: "malformed" };
  const expand = toolExpander(base);
  const tool = base.replace(/\.(?:c|m)?[jt]s$/, "");
  const refs: ConfigReference[] = [];
  let problem: UnreadConfig["reason"] | undefined;
  let importsPackage = false;
  let strings = 0;
  let visited = 0;

  const moduleSpecifier = (spec: ts.Expression | undefined): void => {
    if (spec === undefined) return;
    if (!ts.isStringLiteralLike(spec)) {
      problem ??= "computed specifier";
      return;
    }
    const s = spec.text;
    if (packageOf(s) !== undefined && !isBuiltin(s)) importsPackage = true;
    if (s.startsWith(".") || s.startsWith("/")) {
      const target = s.slice(s.lastIndexOf("/") + 1);
      if (!(EXECUTABLE_CONFIG.test(target) || KNOWN_EXECUTABLE_CONFIGS.has(target))) {
        problem ??= "imports local module";
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (problem || ++visited > 200_000) {
      problem ??= "over limit";
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      moduleSpecifier(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "require" &&
          callee.name.text === "resolve");
      if (loads) moduleSpecifier(node.arguments[0] ?? node);
    } else if (ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) {
      const lead = leadingLiteral(node);
      if (lead !== undefined && NAME_FRAGMENT.test(lead)) problem ??= "computed specifier";
    }
    if (ts.isStringLiteralLike(node) && strings < MAX_CONFIG_STRINGS) {
      strings += 1;
      const packages = expand(node.text);
      if (packages.length) {
        refs.push({
          packages,
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          via: "config",
          source: `${tool} string`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (strings >= MAX_CONFIG_STRINGS) problem ??= "over limit";
  return problem ? { reason: problem } : { refs, importsPackage };
}

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
  const sharedImports: string[] = [];
  const collector =
    (file: string, text: string): Collector =>
    (source, rawNames, expand) => {
      for (const raw of rawNames.slice(0, MAX_NAMES)) {
        const packages = expand(raw);
        if (packages.length)
          refs.push({ packages, file, line: lineOf(text, raw), via: "config", source });
      }
    };

  // A nested package.json starts another project; its files belong to it.
  const nestedRoots = [...inProject]
    .filter((f) => f.endsWith("/package.json"))
    .map((f) => f.slice(0, -"package.json".length));
  const ownFiles = [...inProject]
    .filter((f) => !nestedRoots.some((root) => f.startsWith(root)))
    .sort();
  let configFiles = 0;
  for (const f of ownFiles) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    const nested = f.includes("/");
    if (nested ? KNOWN_EXECUTABLE_CONFIGS.has(base) : EXECUTABLE_CONFIG.test(base)) {
      // Parsed, never evaluated (#149).
      const file = `${prefix}${f}`;
      if (++configFiles > MAX_CONFIG_FILES) {
        unread.push({ file, reason: "over limit" });
        continue;
      }
      const read = await readText(repository, file);
      if (!("text" in read)) {
        unread.push({ file, reason: read.reason as UnreadConfig["reason"] });
        continue;
      }
      const result = readExecutableConfig(file, base, read.text);
      if ("reason" in result) unread.push({ file, reason: result.reason });
      else {
        refs.push(...result.refs);
        if (result.importsPackage) sharedImports.push(file);
      }
      continue;
    }
    const handler = handlerFor(base);
    if (!handler) continue;
    const file = `${prefix}${f}`;
    if (++configFiles > MAX_CONFIG_FILES) {
      unread.push({ file, reason: "over limit" });
      continue;
    }
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
        ...(c.creditPrefix ? { prefixes: [c.creditPrefix] } : {}),
        source: `${file} present`,
      });
    } else if (dir !== undefined) {
      const inside = [...inProject].find((f) => f.startsWith(`${dir}/`)) ?? dir;
      refs.push({
        packages: [c.package],
        file: `${prefix}${inside}`,
        line: 1,
        via: "convention",
        ...(c.creditPrefix ? { prefixes: [c.creditPrefix] } : {}),
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
        ...(c.creditPrefix ? { prefixes: [c.creditPrefix] } : {}),
        source: `package.json "${c.packageJsonKey}" present`,
      });
    }
  }
  return { refs, unread, sharedImports };
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
  return mergeScans(own, await collectDirectory(repository, ".", files));
}

function mergeScans(own: ConfigScan, root: ConfigScan): ConfigScan {
  return {
    refs: [...own.refs, ...root.refs],
    unread: [...own.unread, ...root.unread],
    sharedImports: [...own.sharedImports, ...root.sharedImports],
  };
}

/** One scan per directory per analysis run; the root is scanned once, not once per member. */
const cache = new WeakMap<AdapterContext, Map<string, Promise<ConfigScan>>>();

function directoryScan(context: AdapterContext, dir: string): Promise<ConfigScan> {
  let perDir = cache.get(context);
  if (!perDir) {
    perDir = new Map();
    cache.set(context, perDir);
  }
  let pending = perDir.get(dir);
  if (!pending) {
    pending = (async () => {
      const files = (await context.repository.listFiles()).map((f) => f.replace(/^\.\//, ""));
      return collectDirectory(context.repository, dir, files);
    })();
    perDir.set(dir, pending);
  }
  return pending;
}

async function scanFor(context: AdapterContext, dependency: Dependency): Promise<ConfigScan> {
  const projectDir = dependency.project.path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const own = await directoryScan(context, projectDir);
  return projectDir === "." ? own : mergeScans(own, await directoryScan(context, "."));
}

/** via="config" / via="convention" usages of `dependency` from its project's (and the root's) configs. */
export async function findConfigUsages(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const { refs } = await scanFor(context, dependency);
  return refs
    .filter(
      (r) =>
        r.packages.includes(dependency.name) ||
        (r.prefixes?.some((p) => dependency.name.startsWith(p)) ?? false),
    )
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
  const scan = await scanFor(context, dependency);
  if (scan.sharedImports.length === 0 || (await graphComplete(context, dependency))) {
    return scan.unread;
  }
  return [
    ...scan.unread,
    ...scan.sharedImports.map((file) => ({
      file,
      reason: "imports shared config package" as const,
    })),
  ];
}

/**
 * Lockfiles whose parsed graph includes peer edges (npm packages[].peerDependencies,
 * pnpm resolved peers in snapshots, bun.lock peerDependencies). yarn.lock is
 * excluded: classic does not record peers and Berry's are not parsed yet.
 */
const PEER_RECORDING_LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lock",
]);

/** Whether the dependency's project has a lockfile graph with peer edges, cached per project per run. */
const graphCaches = new WeakMap<AdapterContext, Map<string, Promise<boolean>>>();

function graphComplete(context: AdapterContext, dependency: Dependency): Promise<boolean> {
  let perProject = graphCaches.get(context);
  if (!perProject) {
    perProject = new Map();
    graphCaches.set(context, perProject);
  }
  const key = dependency.project.path;
  let pending = perProject.get(key);
  if (!pending) {
    pending = buildLockfileGraph(context, dependency.project).then(
      (r) =>
        !r.graph.incomplete &&
        r.lockfile !== undefined &&
        PEER_RECORDING_LOCKFILES.has(r.lockfile.slice(r.lockfile.lastIndexOf("/") + 1)),
      () => false,
    );
    perProject.set(key, pending);
  }
  return pending;
}
