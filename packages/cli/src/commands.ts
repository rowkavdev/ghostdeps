import type { Io } from "./cli.js";
import type { CliConfig } from "./config.js";
import { NotImplementedError } from "./errors.js";
import { runScan } from "./scan.js";
import { runFixPreview } from "./fix-preview.js";

/** A CLI command in the router. */
export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly run: (config: CliConfig, io: Io) => Promise<number>;
}

/** Commands the router accepts before their implementation lands. */
function notImplemented(name: string): (config: CliConfig, io: Io) => Promise<number> {
  return () => Promise.reject(new NotImplementedError(`ghostdeps ${name} is not implemented yet`));
}

export const commands: readonly Command[] = [
  {
    name: "scan",
    summary: "Analyse a repository's dependencies",
    usage: "ghostdeps scan [path]",
    run: runScan,
  },
  {
    name: "fix",
    summary: "Preview a supported removal; never writes files",
    usage: "ghostdeps fix <package> [path]",
    run: runFixPreview,
  },
  {
    name: "inspect",
    summary: "Inspect one dependency in depth",
    usage: "ghostdeps inspect <package> [path]",
    run: notImplemented("inspect"),
  },
  {
    name: "graph",
    summary: "Show the transitive graph for one dependency",
    usage: "ghostdeps graph <package> [path]",
    run: notImplemented("graph"),
  },
  {
    name: "languages",
    summary: "List detected languages and package managers",
    usage: "ghostdeps languages [path]",
    run: notImplemented("languages"),
  },
  {
    name: "packages",
    summary: "List direct dependencies",
    usage: "ghostdeps packages [path]",
    run: notImplemented("packages"),
  },
  {
    name: "explain",
    summary: "Explain the findings for one dependency",
    usage: "ghostdeps explain <package> [path]",
    run: notImplemented("explain"),
  },
];

export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}

/** Levenshtein distance, for "did you mean" suggestions on mistyped commands. */
export function editDistance(a: string, b: string): number {
  const previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  const current: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length] ?? 0;
}

/** Closest command name within typo distance, if any. */
export function suggestCommand(word: string): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const command of commands) {
    const distance = editDistance(word, command.name);
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { name: command.name, distance };
    }
  }
  return best?.name;
}
