/**
 * @ghostdeps/cli - the GhostDeps command-line interface. The binary entry is
 * main.ts; this module exposes the runner for embedding and tests. All
 * analysis lives in @ghostdeps/core; the CLI only routes and renders.
 */
export { run, parseArgs, type Io } from "./cli.js";
export { commands, findCommand, suggestCommand, type Command } from "./commands.js";
export type { CliConfig } from "./config.js";
export {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_USAGE,
  EXIT_NOT_IMPLEMENTED,
  CliError,
  UsageError,
  NotImplementedError,
} from "./errors.js";
export { helpText, commandHelp } from "./help.js";
export { printJson, errorJson } from "./output/json.js";
export { cliVersion } from "./version.js";
