import { existsSync } from "node:fs";
import { findCommand, suggestCommand } from "./commands.js";
import type { CliConfig } from "./config.js";
import {
  EXIT_ERROR,
  EXIT_NOT_IMPLEMENTED,
  EXIT_OK,
  EXIT_USAGE,
  NotImplementedError,
  UsageError,
} from "./errors.js";
import { commandHelp, helpText } from "./help.js";
import {
  DEFAULT_RULES,
  parseSeverity,
  type Confidence,
  type PolicyConfig,
  type Severity,
  type ToolingAllowlist,
} from "@ghostdeps/core";
import { defaultAdapters } from "./adapters.js";
import { errorJson } from "./output/json.js";
import { cliVersion } from "./version.js";

/** Output sinks, injected so tests can capture instead of touching process. */
export interface Io {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface ParsedArgs {
  json: boolean;
  help: boolean;
  version: boolean;
  /** Raw --fail-on / --severity values; validated against Severity in buildConfig. */
  failOn?: string | undefined;
  severity?: string | undefined;
  /** Repeatable policy flags; validated in buildConfig. */
  disableRules: string[];
  downgrades: string[];
  allowlist: string[];
  positionals: string[];
  /** `--` was used: every positional is explicitly a path/argument, never a command typo. */
  sawDoubleDash: boolean;
}

/** Options before `--`; after it everything is positional (e.g. paths starting with `-`). */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let json = false;
  let help = false;
  let version = false;
  let failOn: string | undefined;
  let severity: string | undefined;
  const disableRules: string[] = [];
  const downgrades: string[] = [];
  const allowlist: string[] = [];
  let positionalOnly = false;
  let sawDoubleDash = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (positionalOnly) {
      positionals.push(arg);
    } else if (arg === "--") {
      positionalOnly = true;
      sawDoubleDash = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-V") {
      version = true;
    } else if (
      arg === "--fail-on" ||
      arg === "--severity" ||
      arg === "--disable-rule" ||
      arg === "--downgrade" ||
      arg === "--allowlist"
    ) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`${arg} needs a value`);
      }
      if (arg === "--fail-on") failOn = value;
      else if (arg === "--severity") severity = value;
      else if (arg === "--disable-rule") disableRules.push(value);
      else if (arg === "--downgrade") downgrades.push(value);
      else allowlist.push(value);
      i++;
    } else if (arg.startsWith("--fail-on=")) {
      failOn = arg.slice("--fail-on=".length);
    } else if (arg.startsWith("--severity=")) {
      severity = arg.slice("--severity=".length);
    } else if (arg.startsWith("--disable-rule=")) {
      disableRules.push(arg.slice("--disable-rule=".length));
    } else if (arg.startsWith("--downgrade=")) {
      downgrades.push(arg.slice("--downgrade=".length));
    } else if (arg.startsWith("--allowlist=")) {
      allowlist.push(arg.slice("--allowlist=".length));
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return {
    json,
    help,
    version,
    failOn,
    severity,
    disableRules,
    downgrades,
    allowlist,
    positionals,
    sawDoubleDash,
  };
}

/** Does the erroring invocation ask for JSON? (Options after `--` don't count.) */
function wantsJson(argv: string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

/** Commands that analyse a repository path: scan, languages, packages. */
const repoCommands = new Set(["scan", "languages", "packages"]);
/** Commands scoped to one dependency: inspect, graph, explain. */
const packageCommands = new Set(["inspect", "graph", "explain"]);

/**
 * A bare first word is only a path shorthand (`ghostdeps .`) when it looks
 * like one: contains a separator or dot, or exists on disk. Anything else is
 * a mistyped command, and saying so beats scanning the wrong directory.
 */
function looksLikePath(word: string): boolean {
  return word.includes("/") || word.includes(".") || existsSync(word);
}

function unknownCommand(word: string): UsageError {
  const suggestion = suggestCommand(word);
  const hint = suggestion === undefined ? "" : ` (did you mean '${suggestion}'?)`;
  return new UsageError(`unknown command: ${word}${hint}`);
}

function severityFlag(name: string, value: string | undefined): Severity | undefined {
  if (value === undefined) return undefined;
  const parsed = parseSeverity(value);
  if (parsed === undefined) {
    throw new UsageError(
      `unknown severity: ${value} (expected critical, high, medium, low or info)`,
    );
  }
  return parsed;
}

const CONFIDENCES = new Set(["high", "medium", "low"]);

/** A typo'd rule id must fail loudly, never silently match nothing. */
function assertKnownRule(id: string, flag: string): void {
  const known = DEFAULT_RULES.map((rule) => rule.id);
  if (!known.includes(id)) {
    throw new UsageError(`unknown rule for ${flag}: ${id} (known rules: ${known.join(", ")})`);
  }
}

/** Same for ecosystems: an unknown one can only ever be a typo today. */
function assertKnownEcosystem(ecosystem: string): void {
  const known = defaultAdapters().map((adapter) => adapter.ecosystem);
  if (!known.includes(ecosystem)) {
    throw new UsageError(
      `unknown ecosystem for --allowlist: ${ecosystem} (known ecosystems: ${known.join(", ")})`,
    );
  }
}

/** --downgrade <rule>=<confidence>, repeatable. */
function parseDowngrades(values: readonly string[]): Record<string, Confidence> {
  const downgrade: Record<string, Confidence> = {};
  for (const value of values) {
    const eq = value.indexOf("=");
    const confidence = eq === -1 ? "" : value.slice(eq + 1);
    if (eq === -1 || !CONFIDENCES.has(confidence)) {
      throw new UsageError(
        `--downgrade wants <rule>=<confidence> (high, medium or low), got: ${value}`,
      );
    }
    const rule = value.slice(0, eq);
    assertKnownRule(rule, "--downgrade");
    downgrade[rule] = confidence as Confidence;
  }
  return downgrade;
}

/** --allowlist <ecosystem>:<name> for exact names, <ecosystem>:<prefix>* for prefixes. */
function parseAllowlist(values: readonly string[]): Record<string, Partial<ToolingAllowlist>> {
  const allowlist: Record<string, { exact: string[]; prefixes: string[] }> = {};
  for (const value of values) {
    const colon = value.indexOf(":");
    const ecosystem = colon === -1 ? "" : value.slice(0, colon);
    let name = colon === -1 ? "" : value.slice(colon + 1);
    if (ecosystem === "" || name === "") {
      throw new UsageError(
        `--allowlist wants <ecosystem>:<package> (prefix with a trailing *), got: ${value}`,
      );
    }
    assertKnownEcosystem(ecosystem);
    const entry = (allowlist[ecosystem] ??= { exact: [], prefixes: [] });
    if (name.endsWith("*")) {
      name = name.slice(0, -1);
      if (name === "") throw new UsageError(`--allowlist prefix cannot be empty: ${value}`);
      entry.prefixes.push(name);
    } else {
      entry.exact.push(name);
    }
  }
  return allowlist;
}

function buildConfig(
  command: string,
  args: string[],
  json: boolean,
  flags: {
    failOn?: string | undefined;
    severity?: string | undefined;
    disableRules: string[];
    downgrades: string[];
    allowlist: string[];
  },
): CliConfig {
  const failOn = severityFlag("--fail-on", flags.failOn);
  const severity = severityFlag("--severity", flags.severity);
  const hasPolicyFlags =
    flags.disableRules.length > 0 || flags.downgrades.length > 0 || flags.allowlist.length > 0;
  if ((failOn !== undefined || severity !== undefined || hasPolicyFlags) && command !== "scan") {
    throw new UsageError("--fail-on, --severity and the policy flags only apply to ghostdeps scan");
  }
  let policy: PolicyConfig | undefined;
  if (hasPolicyFlags) {
    for (const id of flags.disableRules) assertKnownRule(id, "--disable-rule");
    policy = {
      disabled: flags.disableRules,
      downgrade: parseDowngrades(flags.downgrades),
      allowlist: parseAllowlist(flags.allowlist),
    };
  }
  if (severity !== undefined && json) {
    // --json is always the complete schema-stable result; a display filter
    // has no meaning there and silently ignoring it would lie.
    throw new UsageError(
      "--severity filters human output only; --json always prints the complete result",
    );
  }
  if (repoCommands.has(command)) {
    if (args.length > 1) {
      throw new UsageError(`ghostdeps ${command} takes at most one path argument`);
    }
    return { command, json, path: args[0] ?? ".", failOn, severity, policy };
  }
  if (packageCommands.has(command)) {
    const packageName = args[0];
    if (packageName === undefined) {
      throw new UsageError(`ghostdeps ${command} needs a package name`);
    }
    if (args.length > 2) {
      throw new UsageError(`ghostdeps ${command} takes a package name and at most one path`);
    }
    return { command, json, path: args[1] ?? ".", packageName };
  }
  throw unknownCommand(command);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const json = wantsJson(argv);
  try {
    const parsed = parseArgs(argv);
    const [first, ...rest] = parsed.positionals;

    if (parsed.version) {
      io.stdout(`ghostdeps ${cliVersion()}`);
      return EXIT_OK;
    }
    if (parsed.help || first === "help") {
      const topic = parsed.help ? first : rest[0];
      const command = topic === undefined ? undefined : findCommand(topic);
      if (topic !== undefined && command === undefined && !parsed.help) {
        throw unknownCommand(topic);
      }
      io.stdout(command ? commandHelp(command) : helpText());
      return EXIT_OK;
    }

    const known = first === undefined ? undefined : findCommand(first);
    let command: string;
    let args: string[];
    if (known !== undefined) {
      command = known.name;
      args = rest;
    } else if (first !== undefined && (parsed.sawDoubleDash || looksLikePath(first))) {
      // `ghostdeps .` is shorthand for `ghostdeps scan .`
      command = "scan";
      args = parsed.positionals;
    } else if (first !== undefined) {
      throw unknownCommand(first);
    } else if (parsed.json) {
      // `ghostdeps --json` is shorthand for `ghostdeps scan --json`
      command = "scan";
      args = [];
    } else {
      io.stdout(helpText());
      return EXIT_OK;
    }

    const config = buildConfig(command, args, parsed.json, parsed);
    const entry = findCommand(command);
    if (entry === undefined) {
      throw unknownCommand(command);
    }
    return await entry.run(config, io);
  } catch (error) {
    if (error instanceof NotImplementedError) {
      // --json emits an error object, never an AnalysisResult-shaped body:
      // a clean-looking result would be a false all-clear.
      if (json) {
        io.stdout(errorJson("not-implemented", error.message));
      }
      io.stderr(`${error.message}. Tracked on the GhostDeps roadmap.`);
      return EXIT_NOT_IMPLEMENTED;
    }
    if (error instanceof UsageError) {
      if (json) {
        io.stdout(errorJson("usage", error.message));
      }
      io.stderr(`error: ${error.message}\nRun 'ghostdeps --help' for usage.`);
      return EXIT_USAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      io.stdout(errorJson("error", message));
    }
    io.stderr(`error: ${message}`);
    return EXIT_ERROR;
  }
}
