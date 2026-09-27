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

/** Conservative lexical shadow check; unsupported destructuring also shadows. */
function declares(name: ts.BindingName, wanted: string): boolean {
  if (ts.isIdentifier(name)) return name.text === wanted;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && declares(element.name, wanted),
  );
}
function locallyShadows(use: ts.Node, declaration: ts.Node, name: string): boolean {
  for (
    let scope: ts.Node | undefined = use.parent;
    scope && scope !== declaration.parent;
    scope = scope.parent
  ) {
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      declares(scope.variableDeclaration.name, name)
    )
      return true;
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => declares(p.name, name)))
      return true;
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (d) => declares(d.name, name) && d !== declaration,
          )
        )
          return true;
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return true;
        if (ts.isClassDeclaration(statement) && statement.name?.text === name) return true;
      }
    }
  }
  return false;
}
/** Reject any source-level binding that could replace the platform constructor.
 * This is intentionally conservative across the whole file, including imports,
 * parameter destructuring and assignments. A parse-only scan cannot prove
 * runtime global integrity, so this is only a local citation, not a verdict.
 */
function platformConstructorCandidate(site: ts.Node): boolean {
  const file = site.getSourceFile();
  let candidate = true;
  const visit = (node: ts.Node): void => {
    if (!candidate) return;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      declares(node.name, "AbortController")
    )
      candidate = false;
    if (
      (ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name?.text === "AbortController"
    )
      candidate = false;
    if (ts.isImportClause(node) && node.name?.text === "AbortController") candidate = false;
    if (ts.isImportSpecifier(node) && node.name.text === "AbortController") candidate = false;
    if (ts.isNamespaceImport(node) && node.name.text === "AbortController") candidate = false;
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.left.text === "AbortController" &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      candidate = false;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return candidate;
}
/** Any other use may leak or mutate the instance, including aliases and
 * reflective calls. We cannot establish object integrity from parse-only AST;
 * conservatively reject the positive observation instead of trying to
 * enumerate mutation syntax.
 */
function isolatedController(
  declaration: ts.VariableDeclaration,
  signalAccess: ts.PropertyAccessExpression,
): boolean {
  if (!ts.isIdentifier(declaration.name) || !ts.isIdentifier(signalAccess.expression)) return false;
  const name = declaration.name.text;
  let isolated = true;
  const visit = (node: ts.Node): void => {
    if (!isolated) return;
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node !== declaration.name &&
      node !== signalAccess.expression
    )
      isolated = false;
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return isolated;
}
/** Only this narrowly traced constructor proves the provenance of a signal. */
function controllerOrigin(use: ts.Node, name: string): ts.VariableDeclaration | undefined {
  for (let scope: ts.Node | undefined = use.parent; scope; scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const declarations = statement.declarationList.declarations.filter((d) =>
          declares(d.name, name),
        );
        if (!declarations.length) continue;
        if (
          declarations.length !== 1 ||
          !(statement.declarationList.flags & ts.NodeFlags.Const) ||
          statement.pos > use.pos
        )
          return undefined;
        const declaration = declarations[0]!;
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isNewExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === "AbortController" &&
          platformConstructorCandidate(declaration.initializer.expression)
        )
          return declaration;
        return undefined;
      }
      // A closer function parameter shadows an outer controller.
      if (
        ts.isBlock(scope) &&
        ts.isFunctionLike(scope.parent) &&
        scope.parent.parameters.some((p) => declares(p.name, name))
      )
        return undefined;
    }
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
        const responseDeclaration = ts.isVariableDeclaration(value.parent)
          ? value.parent
          : undefined;
        if (responseDeclaration && ts.isIdentifier(responseDeclaration.name)) {
          responseName = responseDeclaration.name.text;
          add(responseDeclaration);
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
            if (responseDeclaration && locallyShadows(n, responseDeclaration, responseName)) {
              set("status-check", "unknown", n, "response name is shadowed in a nested scope");
              set("parsed-response", "unknown", n, "response name is shadowed in a nested scope");
            } else if (
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
              if (
                (member(child, errorName, "code") || member(child, errorName, "response")) &&
                locallyShadows(child, n.variableDeclaration!, errorName)
              )
                set("error-handling", "unknown", child, "catch binding is shadowed");
              else if (member(child, errorName, "code") || member(child, errorName, "response"))
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
              ts.isIdentifier(n.initializer.expression) &&
              n.initializer.name.text === "signal"
            ) {
              const origin = controllerOrigin(n, n.initializer.expression.text);
              if (origin && isolatedController(origin, n.initializer)) {
                add(origin);
                set("cancellation-propagation", "inspected", n);
                // The constructor citation is as essential as the option site.
                outcomes.get("cancellation-propagation")!.citations.push(span(file, text, origin));
              } else
                set(
                  "cancellation-propagation",
                  "unknown",
                  n,
                  "AbortController origin not established",
                );
            } else set("cancellation-propagation", "unknown", n, "signal origin not resolved");
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
