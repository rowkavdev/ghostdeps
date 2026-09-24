import { commands, type Command } from "./commands.js";

const optionLines = [
  "Options:",
  "  --json              Machine-readable JSON output (schema-versioned)",
  "  --fail-on <sev>     scan: exit 1 when any finding reaches this severity",
  "  --severity <min>    scan: only show findings at or above this severity",
  "  --disable-rule <id> scan: turn off a policy rule (repeatable)",
  "  --downgrade <r>=<c> scan: cap a rule's confidence (repeatable)",
  "  --allowlist <e>:<p> scan: allowlist a tooling package, * suffix = prefix",
  "  -h, --help          Show help",
  "  -V, --version       Show the version",
  "  --                  Treat everything after it as positional (paths starting with -)",
];

const exitCodeLines = [
  "Exit codes:",
  "  0  success (with --fail-on: no finding at or above the threshold)",
  "  1  scan --fail-on threshold met or exceeded",
  "  2  usage error, or the scan itself failed",
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
    "A bare first word is treated as a path only when it contains '/' or '.'",
    "or exists on disk; anything else is reported as an unknown command.",
    "To scan a directory that shares a name with a command, use: ghostdeps scan <dir>",
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
