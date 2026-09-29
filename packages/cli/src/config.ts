import type { PolicyConfig, Severity } from "@ghostdeps/core";

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
  /** Package name for package-scoped commands (inspect, graph, explain, fix). */
  packageName?: string;
  /** scan --fail-on: exit 1 when any finding is at or above this severity. */
  failOn?: Severity | undefined;
  /** scan --severity: only show findings at or above this severity. */
  severity?: Severity | undefined;
  /** scan policy config: --disable-rule / --downgrade / --allowlist. */
  policy?: PolicyConfig | undefined;
  /**
   * scan/fix --fixture-roots: per-run fixture-scope override payload (#354),
   * replacing the committed .ghostdeps.json roots for the run. Absent when the
   * flag was not passed; validated by core at scan time.
   */
  fixtureRoots?: string | undefined;
  /**
   * scan --comments-off: this run must not lead to a maintained PR comment.
   * The CLI never comments itself; the flag is the per-run half of the
   * comments-off switch (the committed half is .ghostdeps.json commentsOff)
   * and is disclosed in the human summary so it is never silently ignored.
   */
  commentsOff?: boolean | undefined;
}
