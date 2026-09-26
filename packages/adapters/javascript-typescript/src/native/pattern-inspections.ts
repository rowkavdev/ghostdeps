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
export type PatternObservationState = "observed" | "not-observed" | "uninspectable";
export interface PatternInspection {
  patternId: string;
  kind: PatternKind;
  inspectedFiles: readonly string[];
  inspectedBytes: number;
  capped: boolean;
  observations: readonly { file: string; start: number; end: number }[];
  uninspectable: readonly { file: string; start: number; end: number; note: string }[];
  state: PatternObservationState;
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
    return node.name.text === id;
  }
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const value = chain(node);
  return value === id || value.endsWith(`.${id}`);
}
function isUnresolvedOptionProperty(node: ts.Node, patternId: string): string | undefined {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const wanted = patternId.replace(/\[\*\]/g, "").replace(/\(.*$/, "");
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) return `object spread may hide option key ${wanted}`;
    if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
      if (property.name && ts.isIdentifier(property.name) && property.name.text === wanted)
        return `getter/setter for option key ${wanted} is not a static value`;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    if (ts.isComputedPropertyName(property.name)) {
      // Even a computed literal is reported as unresolved rather than silently
      // treated as absent. The consumer can apply its own stricter rule.
      return `computed option key may match ${wanted}`;
    }
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) continue;
  }
  return undefined;
}
/** Inspect requested entries with deterministic caps; this is not a completeness claim. */
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
  const unknown = new Map<string, { file: string; start: number; end: number; note: string }[]>();
  for (const p of patterns) {
    found.set(p.patternId, []);
    unknown.set(p.patternId, []);
  }
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
        const uncertain =
          p.kind === "option-key-value" ? isUnresolvedOptionProperty(node, p.patternId) : undefined;
        if (uncertain && unknown.get(p.patternId)!.length < MAX_PATTERN_OBSERVATIONS) {
          unknown.get(p.patternId)!.push({ ...byteSpan(file, text, node), note: uncertain });
        } else if (
          records.length < MAX_PATTERN_OBSERVATIONS &&
          patternMatches(p.kind, p.patternId, node)
        ) {
          records.push(byteSpan(file, text, node));
        } else if (
          records.length >= MAX_PATTERN_OBSERVATIONS ||
          unknown.get(p.patternId)!.length >= MAX_PATTERN_OBSERVATIONS
        )
          capped = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return patterns.map(({ patternId, kind }) => {
    const observations = found.get(patternId)!;
    const uninspectable = unknown.get(patternId)!;
    return {
      patternId,
      kind,
      inspectedFiles,
      inspectedBytes,
      capped,
      observations,
      uninspectable,
      state: observations.length
        ? "observed"
        : uninspectable.length
          ? "uninspectable"
          : "not-observed",
    };
  });
}
