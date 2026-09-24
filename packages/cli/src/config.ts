/**
 * CLI configuration. Today resolution is flags over defaults; when a config
 * file format is agreed it slots in between the two (see docs/cli.md).
 */
export interface CliConfig {
  /** Resolved command name, e.g. "scan". */
  command: string;
  /** Global --json flag: machine-readable, schema-versioned output. */
  json: boolean;
  /** Repository path to analyse, relative or absolute. */
  path: string;
  /** Package name for package-scoped commands (inspect, graph, explain). */
  packageName?: string;
}
