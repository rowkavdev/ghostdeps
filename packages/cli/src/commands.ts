import type { CliConfig } from "./config.js";
import { NotImplementedError } from "./errors.js";

/** A CLI command in the router. */
export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly run: (config: CliConfig) => Promise<number>;
}

/** Commands the router accepts before the engine lands (issue #39 wires scan). */
function notImplemented(name: string): (config: CliConfig) => Promise<number> {
  return () => Promise.reject(new NotImplementedError(`ghostdeps ${name} is not implemented yet`));
}

export const commands: readonly Command[] = [
  {
    name: "scan",
    summary: "Analyse a repository's dependencies",
    usage: "ghostdeps scan [path]",
    run: notImplemented("scan"),
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
