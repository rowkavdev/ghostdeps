/** Bounded, per-pattern source observations for incompatible checks (#447).
 * This records only inspected files and exact AST spans; it does not claim
 * repository/scope completeness. The core owns completeness proofs.
 */
import ts from "typescript";
import { createHash } from "node:crypto";
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
  /** Adapter-side input to the core #446 negative-proof aggregate. These are
   * byte citations, not a snapshot binding or a completeness verdict. Core
   * re-reads the verified listing and bytes before accepting an absence. */
  whereLooked: {
    readonly eligibility: "js-ts-pattern-files-v1";
    readonly files: readonly { path: string; byteLength: number; sha256: string }[];
    readonly calls: readonly { file: string; start: number; end: number }[];
    readonly unchecked: readonly { file: string; reason: string }[];
  };
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
function calleeHasToken(expression: ts.Expression, token: string): boolean {
  if (ts.isIdentifier(expression)) return expression.text === token;
  if (ts.isPropertyAccessExpression(expression))
    return expression.name.text === token || calleeHasToken(expression.expression, token);
  if (ts.isElementAccessExpression(expression))
    return Boolean(
      (expression.argumentExpression &&
        ts.isStringLiteral(expression.argumentExpression) &&
        expression.argumentExpression.text === token) ||
      calleeHasToken(expression.expression, token),
    );
  return false;
}
function idFor(patternId: string): string {
  return patternId.replace(/\[\*\]/g, "").replace(/\(.*$/, "");
}
function isUnresolved(kind: PatternKind, patternId: string, node: ts.Node): string | undefined {
  const wanted = idFor(patternId);
  if (kind === "option-key-value" && ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) return `object spread may hide option key ${wanted}`;
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === wanted)
        return `shorthand option ${wanted} has an unresolved value`;
      if (
        ts.isMethodDeclaration(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === wanted) ||
          ts.isComputedPropertyName(property.name))
      )
        return `method option may hide or define ${wanted}`;
      if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
        if (
          property.name &&
          (ts.isComputedPropertyName(property.name) ||
            (ts.isIdentifier(property.name) && property.name.text === wanted))
        )
          return `computed or unresolved getter/setter may hide option key ${wanted}`;
        continue;
      }
      if (ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name))
        return `computed option key may match ${wanted}`;
    }
  }
  if (kind === "member-call" && ts.isCallExpression(node)) {
    let expr: ts.Expression = node.expression,
      hadComputed = false;
    while (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      if (
        ts.isElementAccessExpression(expr) &&
        (!expr.argumentExpression || !ts.isStringLiteral(expr.argumentExpression))
      )
        hadComputed = true;
      expr = expr.expression;
    }
    const rendered = chain(node.expression);
    if (
      hadComputed &&
      (rendered.includes("interceptors") ||
        calleeHasToken(node.expression, "interceptors") ||
        (wanted.startsWith("interceptors.") &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "use" &&
          calleeHasToken(node.expression, "request")))
    )
      return `computed member access may be incompatible pattern ${wanted}`;
  }
  if (kind === "property-chain" && ts.isElementAccessExpression(node)) {
    const base = chain(node.expression),
      parts = wanted.split("."),
      root = parts[0]!,
      tail = parts.slice(1).join(".");
    if (tail && (base === root || base.endsWith(`.${root}`)))
      return `computed property access may match ${wanted}`;
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
  const fileProof: { path: string; byteLength: number; sha256: string }[] = [];
  const unchecked: { file: string; reason: string }[] = [];
  const calls: { file: string; start: number; end: number }[] = [];
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
      unchecked.push({ file, reason: "source unreadable" });
      continue;
    }
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_SOURCE_BYTES || inspectedBytes + size > MAX_PATTERN_BYTES) {
      capped = true;
      unchecked.push({
        file,
        reason: size > MAX_SOURCE_BYTES ? "source too large" : "scan byte cap reached",
      });
      continue;
    }
    inspectedBytes += size;
    inspectedFiles.push(file);
    fileProof.push({
      path: file,
      byteLength: size,
      sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    });
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(byteSpan(file, text, node));
      for (const p of patterns) {
        const records = found.get(p.patternId)!;
        const uncertain = isUnresolved(p.kind, p.patternId, node);
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
  for (const file of files.slice(MAX_PATTERN_FILES))
    unchecked.push({ file, reason: "file count cap reached" });
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
      whereLooked: {
        eligibility: "js-ts-pattern-files-v1" as const,
        files: fileProof,
        calls,
        unchecked: [
          ...unchecked,
          ...uninspectable.map(({ file, note }) => ({ file, reason: note })),
        ],
      },
      state: observations.length
        ? "observed"
        : uninspectable.length
          ? "uninspectable"
          : "not-observed",
    };
  });
}
