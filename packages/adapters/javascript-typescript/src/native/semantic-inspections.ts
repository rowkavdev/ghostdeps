/**
 * Bounded downstream observations for the Axios catalog (#451). These are
 * citations, not proofs of exhaustiveness or native-API equivalence. In
 * particular an "inspected" record only identifies a local syntactic flow;
 * core must reconstruct spans, verify coverage, and decide whether it blocks.
 */
import ts from "typescript";
import type { RepositoryHandle } from "@ghostdeps/core";
import type {
  MatchedApiLineageChain,
  MatchedApiReference,
  MatchedApiSpan,
} from "./matched-apis.js";
import { MAX_SOURCE_BYTES } from "../usage/find-usage.js";
import { scriptKindFor } from "../usage/scan.js";

export const MAX_SEMANTIC_NODES = 2_000;
/** Maximum flow links per kind record; citations remain the complete evidence. */
export const MAX_FLOW_LINKS = 8;

/**
 * How a flow link's named binding ties back to the matched call through the
 * 8a lineage chain. Core (10d) reconstructs the tie from the cited spans:
 *
 * - "call-result": `declaration` is the variable declarator whose
 *   initialiser contains the record's call span; `declarationBinding` is the
 *   binding's name node inside it (e.g. `res` in `res = await axios.get()`).
 * - "call-site": `declaration` is the record's call span itself and
 *   `declarationBinding` is the package-local occurrence inside the callee
 *   span the lineage chain's final call link cites (e.g. `axios` in
 *   `axios.get()`).
 * - "call-option": the link's `bindingSpan` sits inside the record's call
 *   span (the option handoff, e.g. `controller` in
 *   `signal: controller.signal`) and `declaration` cites the binding's
 *   origin declaration elsewhere (e.g. the `new AbortController()`
 *   declarator).
 *
 * An unresolved tie names a binding that could not be tied to the call; it
 * is never a guessed association and never promotes the claim.
 */
export type SemanticFlowBindingTie =
  | {
      state: "resolved";
      via: "call-result" | "call-site" | "call-option";
      /** Declaration span tying the binding to the matched call. */
      declaration: MatchedApiSpan;
      /** Occurrence of the binding name inside `declaration`. */
      declarationBinding: MatchedApiSpan;
    }
  | { state: "unresolved"; reason: string };

/**
 * One typed link between a semantic flow claim and the local binding it
 * inspects. `span` cites BOTH the flow tokens (`tokenSpan`) and one
 * occurrence of the named binding (`bindingSpan`); both sub-spans are inside
 * `span`. Association is proven by this binding resolution, never by token
 * shape alone.
 */
export interface SemanticFlowLink {
  /** The local binding the claim inspects. */
  binding: string;
  /** Byte-exact span containing both `tokenSpan` and `bindingSpan`. */
  span: MatchedApiSpan;
  /** Occurrence of `binding` inside `span`; decodes to the binding name. */
  bindingSpan: MatchedApiSpan;
  /** Flow tokens inside `span` (e.g. `.status`, `.data`, `catch (error)`). */
  tokenSpan: MatchedApiSpan;
  tie: SemanticFlowBindingTie;
}

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
  /** Same typed package-entry chain as the matched call, never independently inferred. */
  lineageChain?: MatchedApiLineageChain;
  state: SemanticFlowState;
  /** Exact syntactic evidence supporting the state. */
  citations: readonly MatchedApiSpan[];
  /**
   * Binding-resolved flow links: each entry names a local binding the claim
   * inspects and cites one byte-exact span containing BOTH the flow tokens
   * and an occurrence of that binding. Links never promote state: an
   * unresolved tie accompanies an unknown claim and is never association
   * evidence.
   */
  links: readonly SemanticFlowLink[];
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
function spanRange(file: string, text: string, start: number, end: number): MatchedApiSpan {
  return {
    file,
    start: Buffer.byteLength(text.slice(0, start), "utf8"),
    end: Buffer.byteLength(text.slice(0, end), "utf8"),
  };
}
function span(file: string, text: string, node: ts.Node): MatchedApiSpan {
  return spanRange(file, text, node.getStart(), node.getEnd());
}
/** The invoked local identifier of a call (`axios` in `axios.get()`), if any. */
function invokedLocal(node: ts.CallExpression): ts.Identifier | undefined {
  let expression: ts.Expression = node.expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
      expression = expression.expression;
    else if (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    else break;
  }
  return ts.isIdentifier(expression) ? expression : undefined;
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
      const linksByKind = new Map<SemanticFlowKind, SemanticFlowLink[]>();
      const addLink = (kind: SemanticFlowKind, flowLink: SemanticFlowLink): void => {
        if (!text) return;
        const list = linksByKind.get(kind) ?? [];
        if (list.length >= MAX_FLOW_LINKS) return;
        if (
          list.some(
            (prior) =>
              prior.binding === flowLink.binding &&
              prior.span.start === flowLink.span.start &&
              prior.span.end === flowLink.span.end &&
              prior.tie.state === flowLink.tie.state,
          )
        )
          return;
        list.push(flowLink);
        linksByKind.set(kind, list);
      };
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
        /** Tie the package local to the call: the lineage chain's call link. */
        const callSite = ():
          | { tie: Extract<SemanticFlowBindingTie, { state: "resolved" }>; name: string }
          | undefined => {
          const local = invokedLocal(node);
          return local
            ? {
                tie: {
                  state: "resolved",
                  via: "call-site",
                  declaration: span(file, text!, node),
                  declarationBinding: span(file, text!, local),
                },
                name: local.text,
              }
            : undefined;
        };
        if (ts.isAwaitExpression(value)) {
          set("response-handling", "inspected", value);
          const site = callSite();
          if (site)
            addLink("response-handling", {
              binding: site.name,
              span: span(file, text!, value),
              bindingSpan: site.tie.declarationBinding,
              tokenSpan: spanRange(file, text!, value.getStart(), value.expression.getStart()),
              tie: site.tie,
            });
        } else if (ts.isReturnStatement(value.parent) || ts.isArrowFunction(value.parent))
          set("response-handling", "unknown", value, "returned flow escapes local inspection");
        else if (ts.isExpressionStatement(value.parent))
          set("response-handling", "unknown", value, "floating promise has no observed consumer");
        else if (
          ts.isPropertyAccessExpression(value.parent) &&
          value.parent.name.text === "then" &&
          ts.isCallExpression(value.parent.parent)
        ) {
          const thenCall = value.parent.parent;
          const handler = thenCall.arguments[0];
          set(
            "response-handling",
            handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
              ? "inspected"
              : "unknown",
            thenCall,
            handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
              ? undefined
              : "dynamic response handler not inspected",
          );
          const site = callSite();
          if (site)
            addLink("response-handling", {
              binding: site.name,
              span: span(file, text!, thenCall),
              bindingSpan: site.tie.declarationBinding,
              tokenSpan: spanRange(file, text!, value.end, value.parent.end),
              tie: site.tie,
            });
        }
        let responseName: string | undefined;
        const responseDeclaration = ts.isVariableDeclaration(value.parent)
          ? value.parent
          : undefined;
        if (responseDeclaration && ts.isIdentifier(responseDeclaration.name)) {
          responseName = responseDeclaration.name.text;
          add(responseDeclaration);
        }
        let responseReassigned = false;
        /** Tie the response binding to the call: the declarator contains it. */
        const callResultTie = ():
          Extract<SemanticFlowBindingTie, { state: "resolved" }> | undefined =>
          responseDeclaration && ts.isIdentifier(responseDeclaration.name)
            ? {
                state: "resolved",
                via: "call-result",
                declaration: span(file, text!, responseDeclaration),
                declarationBinding: span(file, text!, responseDeclaration.name),
              }
            : undefined;
        /** Value-sensitive response tie: reassignment severs call provenance. */
        const responseTie = (): SemanticFlowBindingTie | undefined =>
          responseReassigned
            ? { state: "unresolved", reason: "response binding is reassigned" }
            : callResultTie();
        // Inspect only the enclosing lexical block. The containing try is
        // separately linked to this call; an unrelated catch cannot supply an
        // error-flow citation. Never use a neighbouring function's flow.
        let boundary: ts.Node = sf;
        let containingTry: ts.TryStatement | undefined;
        for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
          if (ts.isTryStatement(at) && at.tryBlock.pos <= node.pos && node.end <= at.tryBlock.end)
            containingTry ??= at;
          if (ts.isBlock(at) && boundary === sf) boundary = at;
          if (ts.isFunctionLike(at)) break;
        }
        const withinCallFlow = (n: ts.Node): boolean =>
          n.pos >= node.pos &&
          // A use in the same statement as the call is not a downstream use.
          n.pos >= (responseDeclaration?.end ?? node.end);
        const visit = (n: ts.Node): void => {
          if (capped) return;
          add(n);
          if (
            responseName &&
            ts.isIdentifier(n) &&
            n.text === responseName &&
            n !== responseDeclaration?.name &&
            withinCallFlow(n)
          ) {
            if (responseDeclaration && locallyShadows(n, responseDeclaration, responseName)) {
              set("status-check", "unknown", n, "response name is shadowed in a nested scope");
              set("parsed-response", "unknown", n, "response name is shadowed in a nested scope");
              if (
                (ts.isPropertyAccessExpression(n.parent) ||
                  ts.isElementAccessExpression(n.parent)) &&
                n.parent.expression === n
              )
                for (const kind of ["status-check", "parsed-response"] as const)
                  addLink(kind, {
                    binding: responseName,
                    span: span(file, text!, n.parent),
                    bindingSpan: span(file, text!, n),
                    tokenSpan: spanRange(file, text!, n.end, n.parent.end),
                    tie: {
                      state: "unresolved",
                      reason: "response name is shadowed in a nested scope",
                    },
                  });
            } else if (
              ts.isBinaryExpression(n.parent) &&
              n.parent.left === n &&
              n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ) {
              set("status-check", "unknown", n, "response binding is reassigned");
              set("parsed-response", "unknown", n, "response binding is reassigned");
              responseReassigned = true;
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
                ) {
                  const condition = ts.isIfStatement(test) ? test.expression : test.condition;
                  set("status-check", "inspected", condition);
                  const tie = responseTie();
                  if (tie)
                    addLink("status-check", {
                      binding: responseName,
                      span: span(file, text!, condition),
                      bindingSpan: span(file, text!, n),
                      tokenSpan: spanRange(file, text!, access.expression.end, access.end),
                      tie,
                    });
                } else {
                  set("status-check", "unknown", access, "status read is not a checked condition");
                  const tie = responseTie();
                  if (tie)
                    addLink("status-check", {
                      binding: responseName,
                      span: span(file, text!, access),
                      bindingSpan: span(file, text!, n),
                      tokenSpan: spanRange(file, text!, access.expression.end, access.end),
                      tie,
                    });
                }
              } else if (member(access, responseName, "data")) {
                set(
                  "parsed-response",
                  "incompatible",
                  access,
                  "Axios response.data requires a parsing decision",
                );
                const tie = responseTie();
                if (tie)
                  addLink("parsed-response", {
                    binding: responseName,
                    span: span(file, text!, access),
                    bindingSpan: span(file, text!, n),
                    tokenSpan: spanRange(file, text!, access.expression.end, access.end),
                    tie,
                  });
              } else {
                set("parsed-response", "unknown", access, "other response member is unclassified");
                const tie = responseTie();
                if (tie)
                  addLink("parsed-response", {
                    binding: responseName,
                    span: span(file, text!, access),
                    bindingSpan: span(file, text!, n),
                    tokenSpan: spanRange(file, text!, access.expression.end, access.end),
                    tie,
                  });
              }
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
          // Status-shaped checks on any other binding: present, but never
          // associated with this call through the lineage chain.
          if (
            (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text !== responseName &&
            (member(n, n.expression.text, "status") || member(n, n.expression.text, "ok"))
          ) {
            const test = ancestor(n, (a) => ts.isIfStatement(a) || ts.isConditionalExpression(a));
            if (
              test &&
              (ts.isIfStatement(test) || ts.isConditionalExpression(test)) &&
              n.pos >= (ts.isIfStatement(test) ? test.expression : test.condition).pos &&
              n.end <= (ts.isIfStatement(test) ? test.expression : test.condition).end
            )
              addLink("status-check", {
                binding: n.expression.text,
                span: span(file, text!, ts.isIfStatement(test) ? test.expression : test.condition),
                bindingSpan: span(file, text!, n.expression),
                tokenSpan: spanRange(file, text!, n.expression.end, n.end),
                tie: {
                  state: "unresolved",
                  reason: `binding "${n.expression.text}" does not resolve to the matched call through the lineage chain`,
                },
              });
          }
          if (
            ts.isCatchClause(n) &&
            containingTry?.catchClause === n &&
            n.variableDeclaration &&
            ts.isIdentifier(n.variableDeclaration.name)
          ) {
            const errorName = n.variableDeclaration.name.text;
            const check = (child: ts.Node): void => {
              add(child);
              if (
                (member(child, errorName, "code") || member(child, errorName, "response")) &&
                locallyShadows(child, n.variableDeclaration!, errorName)
              ) {
                set("error-handling", "unknown", child, "catch binding is shadowed");
                if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child))
                  addLink("error-handling", {
                    binding: errorName,
                    span: span(file, text!, child),
                    bindingSpan: span(file, text!, child.expression),
                    tokenSpan: spanRange(file, text!, child.expression.end, child.end),
                    tie: { state: "unresolved", reason: "catch binding is shadowed" },
                  });
              } else if (member(child, errorName, "code") || member(child, errorName, "response"))
                set(
                  "error-handling",
                  "inspected",
                  n,
                  "Axios-specific error field observed; core decides compatibility",
                );
              ts.forEachChild(child, check);
            };
            check(n.block);
            if (!outcomes.has("error-handling")) set("error-handling", "inspected", n);
            // The try/catch region and the awaited binding inside it.
            const result = responseName ? callResultTie() : undefined;
            const site = result ? undefined : callSite();
            const tie = result ?? site?.tie;
            const binding = result && responseName ? responseName : site?.name;
            if (tie && binding)
              addLink("error-handling", {
                binding,
                span: span(file, text!, containingTry),
                bindingSpan:
                  result && responseDeclaration && ts.isIdentifier(responseDeclaration.name)
                    ? span(file, text!, responseDeclaration.name)
                    : tie.declarationBinding,
                tokenSpan: spanRange(file, text!, n.getStart(), n.block.getStart()),
                tie,
              });
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
                addLink("cancellation-propagation", {
                  binding: n.initializer.expression.text,
                  span: span(file, text!, n),
                  bindingSpan: span(file, text!, n.initializer.expression),
                  tokenSpan: span(file, text!, n.name),
                  tie: {
                    state: "resolved",
                    via: "call-option",
                    declaration: span(file, text!, origin),
                    declarationBinding: span(file, text!, origin.name),
                  },
                });
              } else {
                set(
                  "cancellation-propagation",
                  "unknown",
                  n,
                  "AbortController origin not established",
                );
                addLink("cancellation-propagation", {
                  binding: n.initializer.expression.text,
                  span: span(file, text!, n),
                  bindingSpan: span(file, text!, n.initializer.expression),
                  tokenSpan: span(file, text!, n.name),
                  tie: {
                    state: "unresolved",
                    reason: "AbortController origin not established",
                  },
                });
              }
            } else {
              set("cancellation-propagation", "unknown", n, "signal origin not resolved");
              if (ts.isIdentifier(n.initializer))
                addLink("cancellation-propagation", {
                  binding: n.initializer.text,
                  span: span(file, text!, n),
                  bindingSpan: span(file, text!, n.initializer),
                  tokenSpan: span(file, text!, n.name),
                  tie: { state: "unresolved", reason: "signal origin not resolved" },
                });
            }
          }
          if (n !== node && ts.isFunctionLike(n)) {
            // A closure may consume the response later. A parse-only walk
            // cannot resolve invocation or captured state, so cite the escape.
            if (responseName) {
              let captured = false;
              const capture = (child: ts.Node): void => {
                if (ts.isIdentifier(child) && child.text === responseName) captured = true;
                ts.forEachChild(child, capture);
              };
              capture(n);
              if (captured) {
                set("status-check", "unknown", n, "response captured by nested handler");
                set("parsed-response", "unknown", n, "response captured by nested handler");
              }
            }
            return;
          }
          ts.forEachChild(n, visit);
        };
        visit(boundary);
        // The catch clause is outside the try block used as a lexical
        // boundary, so visit it explicitly only when the call is in that try.
        if (containingTry?.catchClause && boundary !== containingTry)
          visit(containingTry.catchClause);
      }
      for (const kind of KINDS) {
        const outcome = outcomes.get(kind);
        records.push({
          difference: difference(kind),
          kind,
          call,
          lineage,
          ...(ref.lineageChain ? { lineageChain: ref.lineageChain } : {}),
          links: linksByKind.get(kind) ?? [],
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
