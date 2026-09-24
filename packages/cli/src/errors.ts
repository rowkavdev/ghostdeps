/**
 * Exit codes are part of the CLI contract (docs/cli.md). Scripts and CI
 * rely on them, so they only ever change deliberately.
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_IMPLEMENTED = 3;

/** Base class for errors that map to a documented exit code. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** The invocation itself was wrong: unknown option, missing argument. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_USAGE);
  }
}

/** The command is on the roadmap but has no implementation yet. */
export class NotImplementedError extends CliError {
  constructor(message: string) {
    super(message, EXIT_NOT_IMPLEMENTED);
  }
}
