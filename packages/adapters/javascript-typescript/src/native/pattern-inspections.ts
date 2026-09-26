/** Bounded, per-pattern source observations for incompatible checks (#447).
 * This records only inspected files and exact AST spans; it does not claim
 * repository/scope completeness. The core owns completeness proofs.
 */
import ts from "typescript";
import { MAX_SOURCE_BYTES } from "../usage/find-usage.js";
import { scriptKindFor, SCANNABLE_EXTENSIONS } from "../usage/scan.js";
import type { RepositoryHandle } from "@ghostdeps/core";

export const MAX_PATTERN_FILES = 2_000;
export const MAX_PATTERN_BYTES = 8_000_000;
export const MAX_PATTERN_OBSERVATIONS = 1_000;
export type PatternKind = "member-call" | "option-key-value" | "property-chain";
export interface PatternInspection {
  patternId: string;
  kind: PatternKind;
  inspectedFiles: readonly string[];
  inspectedBytes: number;
  capped: boolean;
  observations: readonly { file: string; start: number; end: number }[];
  state: "observed" | "not-observed";
}
const excluded = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
function eligible(file: string): boolean {
  return (
    SCANNABLE_EXTENSIONS.some((ext) => file.endsWith(ext)) &&
    !file.split("/").some((part) => excluded.has(part))
  );
}
function byteSpan(
  file: string,
  text: string,
  node: ts.Node,
): { file: string; start: number; end: number } {
  return {
    file,
    start: Buffer.byteLength(text.slice(0, node.getStart()), "utf8"),
    end: Buffer.byteLength(text.slice(0, node.getEnd()), "utf8"),
  };
}
function chain(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${chain(node.expression)}.${node.name.text}`;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return `${chain(node.expression)}.${node.argumentExpression.text}`;
  return "";
}
function patternMatches(kind: PatternKind, patternId: string, node: ts.Node): boolean {
  const id = patternId.replace(/\[\*\]/g, "").replace(/\(.*$/, "");
  if (kind === "member-call") {
    if (!ts.isCallExpression(node)) return false;
    const target = chain(node.expression);
    return target === id || target.endsWith(`.${id}`) || target.endsWith(`.${id}.use`);
  }
  if (kind === "option-key-value") {
    if (
      !ts.isPropertyAssignment(node) ||
      (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name))
    )
      return false;
    return (ts.isIdentifier(node.name) ? node.name.text : node.name.text) === id;
  }
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const value = chain(node);
  return value === id || value.endsWith(`.${id}`);
}
/** Inspect the requested catalog entries over a deterministic, capped file set. */
export async function inspectIncompatiblePatterns(
  repository: RepositoryHandle,
  patterns: readonly { patternId: string; kind: PatternKind }[],
): Promise<PatternInspection[]> {
  const files = (await repository.listFiles())
    .map((f) => f.replace(/^\.\//, ""))
    .filter(eligible)
    .sort();
  const selected = files.slice(0, MAX_PATTERN_FILES);
  const inspectedFiles: string[] = [];
  const found = new Map<string, { file: string; start: number; end: number }[]>();
  for (const p of patterns) found.set(p.patternId, []);
  let inspectedBytes = 0;
  let capped = files.length > selected.length;
  for (const file of selected) {
    let text: string;
    try {
      text = await repository.readFile(file);
    } catch {
      capped = true;
      continue;
    }
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_SOURCE_BYTES || inspectedBytes + size > MAX_PATTERN_BYTES) {
      capped = true;
      continue;
    }
    inspectedBytes += size;
    inspectedFiles.push(file);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const visit = (node: ts.Node): void => {
      for (const p of patterns) {
        const records = found.get(p.patternId)!;
        if (records.length < MAX_PATTERN_OBSERVATIONS && patternMatches(p.kind, p.patternId, node))
          records.push(byteSpan(file, text, node));
        else if (records.length >= MAX_PATTERN_OBSERVATIONS) capped = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return patterns.map(({ patternId, kind }) => ({
    patternId,
    kind,
    inspectedFiles,
    inspectedBytes,
    capped,
    observations: found.get(patternId)!,
    state: found.get(patternId)!.length ? "observed" : "not-observed",
  }));
}
