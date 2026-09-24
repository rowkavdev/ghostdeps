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
  let positionalOnly = false;
  let sawDoubleDash = false;
  for (const arg of argv) {
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
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { json, help, version, positionals, sawDoubleDash };
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

function buildConfig(command: string, args: string[], json: boolean): CliConfig {
  if (repoCommands.has(command)) {
    if (args.length > 1) {
      throw new UsageError(`ghostdeps ${command} takes at most one path argument`);
    }
    return { command, json, path: args[0] ?? "." };
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

    const config = buildConfig(command, args, parsed.json);
    const entry = findCommand(command);
    if (entry === undefined) {
      throw unknownCommand(command);
    }
    return await entry.run(config);
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
