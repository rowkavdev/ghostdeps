import { commands, type Command } from "./commands.js";

const optionLines = [
  "Options:",
  "  --json        Machine-readable JSON output (schema-versioned)",
  "  -h, --help    Show help",
  "  -V, --version Show the version",
];

const exitCodeLines = [
  "Exit codes:",
  "  0  success",
  "  1  unexpected error",
  "  2  usage error (unknown command or arguments)",
  "  3  command not implemented yet",
];

const footer = [
  "All analysis is static and works offline. The CLI and the GitHub App share",
  "one analysis engine (@ghostdeps/core); there is no separate implementation.",
];

export function helpText(): string {
  const width = Math.max(...commands.map((command) => command.usage.length));
  return [
    "GhostDeps - find dependencies your code doesn't really need.",
    "",
    "Usage:",
    "  ghostdeps <command> [options]",
    "  ghostdeps [path]    shorthand for: ghostdeps scan [path]",
    "",
    "Commands:",
    ...commands.map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}`),
    "",
    ...optionLines,
    "",
    ...exitCodeLines,
    "",
    ...footer,
  ].join("\n");
}

export function commandHelp(command: Command): string {
  return [
    `ghostdeps ${command.name} - ${command.summary}`,
    "",
    "Usage:",
    `  ${command.usage}`,
    "",
    ...optionLines.slice(0, 2),
    "",
    ...exitCodeLines,
  ].join("\n");
}
