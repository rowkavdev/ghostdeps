/**
 * Bounded downstream observations for the Axios catalog (#451). These are
 * citations, not proofs of exhaustiveness or native-API equivalence. In
 * particular an "inspected" record only identifies a local syntactic flow;
 * core must reconstruct spans, verify coverage, and decide whether it blocks.
 */
import ts from "typescript";
import type { RepositoryHandle } from "@ghostdeps/core";
import type { MatchedApiReference, MatchedApiSpan } from "./matched-apis.js";
import { MAX_SOURCE_BYTES } from "../usage/find-usage.js";
import { scriptKindFor } from "../usage/scan.js";

export const MAX_SEMANTIC_NODES = 2_000;
export type SemanticFlowKind =
  | "response-handling"
  | "status-check"
  | "parsed-response"
  | "error-handling"
  | "cancellation-propagation";
export type SemanticFlowState = "inspected" | "unknown" | "incompatible";
export interface SemanticFlowInspection {
  difference: string;
  kind: SemanticFlowKind;
  call: MatchedApiSpan;
  /** The original matched-API hop citations, not a newly inferred binding. */
  lineage: readonly MatchedApiSpan[];
  state: SemanticFlowState;
  /** Exact syntactic evidence supporting the state. */
  citations: readonly MatchedApiSpan[];
  /** What was actually visited, capped per call. Never a completeness claim. */
  explored: readonly MatchedApiSpan[];
  capped: boolean;
  note?: string;
}
const KINDS: readonly SemanticFlowKind[] = [
  "response-handling",
  "status-check",
  "parsed-response",
  "error-handling",
  "cancellation-propagation",
];
/** Axios v1 has three rule difference IDs; do not invent replacement IDs. */
const DIFFERENCES = [
  "fetch resolves HTTP error statuses unless response.ok is checked",
  "fetch returns a Response, not Axios's parsed response.data",
  "fetch cancellation, redirect, timeout and credentials behavior differ",
] as const;
function difference(kind: SemanticFlowKind): string {
  return DIFFERENCES[kind === "parsed-response" ? 1 : kind === "cancellation-propagation" ? 2 : 0]!;
}
function span(file: string, text: string, node: ts.Node): MatchedApiSpan {
  return {
    file,
    start: Buffer.byteLength(text.slice(0, node.getStart()), "utf8"),
    end: Buffer.byteLength(text.slice(0, node.getEnd()), "utf8"),
  };
}
function member(node: ts.Node, name: string, property: string): boolean {
  return (
    ((ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name &&
      node.name.text === property) ||
      (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === name &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === property)) === true
  );
}
function ancestor(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node | undefined {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (predicate(at)) return at;
    if (ts.isFunctionLike(at) || ts.isSourceFile(at)) break;
  }
  return undefined;
}
/** Trace only local syntax. A flow escaping this boundary remains unknown. */
export async function inspectSemanticFlows(
  repository: RepositoryHandle,
  references: readonly MatchedApiReference[],
): Promise<SemanticFlowInspection[]> {
  const records: SemanticFlowInspection[] = [];
  const files = new Map<string, MatchedApiReference[]>();
  for (const ref of references) {
    if (ref.packageName !== "axios" || !ref.span) continue;
    const list = files.get(ref.span.file) ?? [];
    list.push(ref);
    files.set(ref.span.file, list);
  }
  for (const [file, refs] of files) {
    let text: string | undefined;
    try {
      text = await repository.readFile(file);
    } catch {
      // Each use still gets a located unknown. No omitted flow on I/O failure.
    }
    const sf =
      text !== undefined &&
      Buffer.byteLength(text, "utf8") <= MAX_SOURCE_BYTES &&
      scriptKindFor(file)
        ? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file))
        : undefined;
    const calls = new Map<string, ts.CallExpression>();
    if (sf && text) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const s = span(file, text!, node);
          calls.set(`${s.start}:${s.end}`, node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    for (const ref of refs) {
      const call = ref.span!;
      const node = calls.get(`${call.start}:${call.end}`);
      const lineage = ref.lineage.map((hop) => hop.span);
      const explored: MatchedApiSpan[] = [];
      const seen = new Set<ts.Node>();
      let capped = false;
      const add = (n: ts.Node): void => {
        if (seen.has(n)) return;
        seen.add(n);
        if (text && explored.length < MAX_SEMANTIC_NODES) {
          const citation = span(file, text, n);
          if (citation.end > citation.start) explored.push(citation);
        } else capped = true;
      };
      type Observation = { state: SemanticFlowState; citations: MatchedApiSpan[]; note?: string };
      const outcomes = new Map<SemanticFlowKind, Observation>();
      const set = (
        kind: SemanticFlowKind,
        state: SemanticFlowState,
        n: ts.Node,
        note?: string,
      ): void => {
        if (!text) return;
        const prior = outcomes.get(kind);
        // A later unknown always wins over a local observation. Contradictory
        // paths are unknown, not whichever branch happened to be visited first.
        if (prior && prior.state !== state) {
          outcomes.set(kind, {
            state: "unknown",
            citations: [...prior.citations, span(file, text, n)],
            note: "multiple downstream paths require independent resolution",
          });
        } else {
          outcomes.set(kind, {
            state,
            citations: [...(prior?.citations ?? []), span(file, text, n)],
            ...(note ? { note } : {}),
          });
        }
      };
      if (node && text && sf) {
        add(node);
        let value: ts.Node = node;
        while (ts.isParenthesizedExpression(value.parent) || ts.isAwaitExpression(value.parent)) {
          value = value.parent;
          add(value);
        }
        if (ts.isAwaitExpression(value)) set("response-handling", "inspected", value);
        else if (ts.isReturnStatement(value.parent) || ts.isArrowFunction(value.parent))
          set("response-handling", "unknown", value, "returned flow escapes local inspection");
        else if (ts.isExpressionStatement(value.parent))
          set("response-handling", "unknown", value, "floating promise has no observed consumer");
        else if (
          ts.isPropertyAccessExpression(value.parent) &&
          value.parent.name.text === "then" &&
          ts.isCallExpression(value.parent.parent)
        )
          set("response-handling", "inspected", value.parent.parent);
        let responseName: string | undefined;
        if (ts.isVariableDeclaration(value.parent) && ts.isIdentifier(value.parent.name)) {
          responseName = value.parent.name.text;
          add(value.parent);
        }
        // A single lexical block is the bounded exploration unit. Identifiers
        // outside it, reassignments, and unresolvable branches are not followed.
        let boundary: ts.Node = sf;
        for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
          if (ts.isTryStatement(at)) {
            boundary = at;
            break;
          }
          if (ts.isBlock(at) && boundary === sf) boundary = at;
          if (ts.isFunctionLike(at)) break;
        }
        const visit = (n: ts.Node): void => {
          if (capped) return;
          add(n);
          if (
            responseName &&
            ts.isIdentifier(n) &&
            n.text === responseName &&
            n !==
              (value.parent && ts.isVariableDeclaration(value.parent)
                ? value.parent.name
                : undefined)
          ) {
            if (
              ts.isBinaryExpression(n.parent) &&
              n.parent.left === n &&
              n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ) {
              set("status-check", "unknown", n, "response binding is reassigned");
              set("parsed-response", "unknown", n, "response binding is reassigned");
            } else if (
              (ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) &&
              n.parent.expression === n
            ) {
              const access = n.parent;
              if (member(access, responseName, "status") || member(access, responseName, "ok")) {
                const test = ancestor(
                  access,
                  (a) => ts.isIfStatement(a) || ts.isConditionalExpression(a),
                );
                if (
                  test &&
                  (ts.isIfStatement(test) || ts.isConditionalExpression(test)) &&
                  access.pos >= (ts.isIfStatement(test) ? test.expression : test.condition).pos &&
                  access.end <= (ts.isIfStatement(test) ? test.expression : test.condition).end
                )
                  set("status-check", "inspected", access);
                else
                  set("status-check", "unknown", access, "status read is not a checked condition");
              } else if (member(access, responseName, "data"))
                set(
                  "parsed-response",
                  "incompatible",
                  access,
                  "Axios response.data requires a parsing decision",
                );
              else
                set("parsed-response", "unknown", access, "other response member is unclassified");
            } else if (!ts.isVariableDeclaration(n.parent)) {
              set("status-check", "unknown", n, "response value escapes local member inspection");
              set(
                "parsed-response",
                "unknown",
                n,
                "response value escapes local member inspection",
              );
            }
          }
          if (
            ts.isCatchClause(n) &&
            boundary === n.parent &&
            n.variableDeclaration &&
            ts.isIdentifier(n.variableDeclaration.name)
          ) {
            const errorName = n.variableDeclaration.name.text;
            const check = (child: ts.Node): void => {
              add(child);
              if (member(child, errorName, "code") || member(child, errorName, "response"))
                set(
                  "error-handling",
                  "inspected",
                  child,
                  "Axios-specific error field observed; core decides compatibility",
                );
              ts.forEachChild(child, check);
            };
            check(n.block);
            if (!outcomes.has("error-handling")) set("error-handling", "inspected", n);
          }
          if (
            ts.isPropertyAssignment(n) &&
            n.name.getText(sf) === "signal" &&
            ref.argumentSpans?.some(
              (s) =>
                s.file === file &&
                s.start <= span(file, text!, n).start &&
                s.end >= span(file, text!, n).end,
            )
          ) {
            if (
              ts.isPropertyAccessExpression(n.initializer) &&
              n.initializer.name.text === "signal"
            )
              set("cancellation-propagation", "inspected", n);
            else if (ts.isIdentifier(n.initializer))
              set("cancellation-propagation", "unknown", n, "signal origin not resolved");
          }
          if (n !== node && ts.isFunctionLike(n)) return; // never infer nested closure flow
          ts.forEachChild(n, visit);
        };
        visit(boundary);
      }
      for (const kind of KINDS) {
        const outcome = outcomes.get(kind);
        records.push({
          difference: difference(kind),
          kind,
          call,
          lineage,
          state: !node || capped ? "unknown" : (outcome?.state ?? "unknown"),
          citations: outcome?.citations ?? [call],
          explored,
          capped,
          ...(!node || capped || !outcome
            ? {
                note: !node
                  ? "source uninspectable or call citation not located"
                  : capped
                    ? "exploration cap reached"
                    : "no resolved local flow for this difference",
              }
            : outcome.note
              ? { note: outcome.note }
              : {}),
        });
      }
    }
  }
  return records;
}
