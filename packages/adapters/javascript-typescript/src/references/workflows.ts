/**
 * CI workflow references (via="script"). A tool run only from CI
 * (`npm exec publint --strict` in .github/workflows) is used even though no
 * package.json script mentions it. Workflow YAML is parsed as data and its
 * `run:` steps are read as text, exactly like package.json scripts. Nothing
 * runs.
 *
 * Workflows only ever add usage. They never make a project incomplete: CI
 * steps are full of shell and system tools, and treating those as gaps would
 * mark every repository incomplete.
 */
import { parse as parseYaml } from "yaml";
import type { AdapterContext, Dependency, Usage } from "@ghostdeps/core";
import { MAX_CONFIG_BYTES } from "./config.js";
import { binNames, commandWords, mentions } from "./scripts.js";

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** Workflow files, jobs per file and steps per job that are read. */
const MAX_WORKFLOWS = 200;
const MAX_JOBS = 200;
const MAX_STEPS = 500;

interface RunStep {
  file: string;
  line: number;
  command: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at < 0) return 1;
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

async function readRunSteps(context: AdapterContext): Promise<RunStep[]> {
  const files = (await context.repository.listFiles())
    .map((f) => f.replace(/^\.\//, ""))
    .filter((f) => WORKFLOW_FILE.test(f))
    .slice(0, MAX_WORKFLOWS);
  const steps: RunStep[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await context.repository.readFile(file);
    } catch {
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) continue;
    let doc: unknown;
    try {
      doc = parseYaml(text, { maxAliasCount: 100, uniqueKeys: true });
    } catch {
      continue;
    }
    const jobs = isRecord(doc) && Object.hasOwn(doc, "jobs") ? doc.jobs : undefined;
    if (!isRecord(jobs)) continue;
    for (const job of Object.values(jobs).slice(0, MAX_JOBS)) {
      const list = isRecord(job) && Object.hasOwn(job, "steps") ? job.steps : undefined;
      if (!Array.isArray(list)) continue;
      for (const step of list.slice(0, MAX_STEPS)) {
        const run = isRecord(step) && Object.hasOwn(step, "run") ? step.run : undefined;
        if (typeof run !== "string") continue;
        const first = run.split("\n").find((l) => l.trim()) ?? run;
        steps.push({ file, line: lineOf(text, first.trim()), command: run });
      }
    }
  }
  return steps;
}

const cache = new WeakMap<AdapterContext, Promise<RunStep[]>>();

function stepsFor(context: AdapterContext): Promise<RunStep[]> {
  let pending = cache.get(context);
  if (!pending) {
    pending = readRunSteps(context);
    cache.set(context, pending);
  }
  return pending;
}

/** via="script" usages of `dependency` in the repository's CI workflow `run:` steps. */
export async function findWorkflowUsages(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const steps = await stepsFor(context);
  if (steps.length === 0) return [];
  const bins = await binNames(context, dependency);
  const usages: Usage[] = [];
  for (const step of steps) {
    const hits = [
      ...new Set([
        ...commandWords(step.command).filter((w) => bins.has(w)),
        ...mentions(step.command, dependency.name),
      ]),
    ];
    if (hits.length === 0) continue;
    usages.push({
      dependency: dependency.name,
      file: step.file,
      line: step.line,
      form: "unknown",
      via: "script",
      symbols: hits,
    });
  }
  return usages;
}
