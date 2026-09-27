/** Snapshot-bound semantic pillar with bounded cited-flow reconstruction. */
import { createHash } from "node:crypto";
import type { Node as TsNode } from "typescript";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import type { NativeRule } from "./index.js";
import type { NativeSemanticCheck, NativeSourceProof } from "./producer.js";
import { verifyNativeSnapshot } from "./snapshot.js";
import type { NativeReferenceSpan, NativeLineageChain } from "./matched-api.js";
import { reconstructLineage } from "./lineage.js";

export type NativeFlowKind =
  | "response-handling"
  | "status-check"
  | "parsed-response"
  | "error-handling"
  | "cancellation-propagation";
export interface NativeFlowLink {
  readonly binding: string;
  readonly span: NativeReferenceSpan;
  readonly bindingSpan: NativeReferenceSpan;
  readonly tokenSpan: NativeReferenceSpan;
  readonly tie:
    | { readonly state: "unresolved"; readonly reason: string }
    | {
        readonly state: "resolved";
        readonly via: "call-result" | "call-site" | "call-option";
        readonly declaration: NativeReferenceSpan;
        readonly declarationBinding: NativeReferenceSpan;
      };
}
export interface NativeSemanticNegativeProof {
  readonly scope: NativeReferenceSpan;
  readonly options: readonly NativeReferenceSpan[];
  readonly inspected: readonly NativeReferenceSpan[];
}
export interface NativeFlowInspection {
  readonly difference: string;
  readonly kind: NativeFlowKind;
  readonly call: NativeReferenceSpan;
  readonly lineage: readonly NativeReferenceSpan[];
  readonly lineageChain?: NativeLineageChain;
  readonly links: readonly NativeFlowLink[];
  readonly linksCapped: boolean;
  readonly state: "inspected-observed" | "inspected-absent" | "unknown";
  readonly negativeProof?: NativeSemanticNegativeProof;
  readonly citations: readonly NativeReferenceSpan[];
  readonly explored: readonly NativeReferenceSpan[];
  readonly capped: boolean;
  readonly note?: string;
}
export interface NativeSemanticBlock {
  readonly difference: string;
  readonly call?: NativeReferenceSpan;
  readonly reason:
    | "snapshot-unverified"
    | "missing-flow"
    | "citation-inconsistent"
    | "incomplete-exploration"
    | "unknown"
    | "absence-unreconstructed"
    | "association-unresolved"
    | "incomplete-links";
}
/** Core validates cited flow tokens and their binding tie to reconstructed lineage.
 * This remains a pillar, not a verdict about native replacement equivalence.
 */
export type NativeSemanticResult =
  | {
      readonly status: "blocked";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted" | "verified";
      readonly lineageVerification: "adapter-asserted" | "core-reconstructed";
      readonly policy: string | null;
      readonly checks: readonly NativeSemanticCheck[];
      readonly blocking: readonly [NativeSemanticBlock, ...NativeSemanticBlock[]];
    }
  | {
      readonly status: "pass";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted" | "verified";
      readonly lineageVerification: "adapter-asserted" | "core-reconstructed";
      readonly policy: string | null;
      readonly checks: readonly NativeSemanticCheck[];
      readonly blocking: readonly [];
    };
const kinds: readonly NativeFlowKind[] = [
  "response-handling",
  "status-check",
  "parsed-response",
  "error-handling",
  "cancellation-propagation",
];
const MAX_NODES = 2_000;
const validPath = (file: string): boolean =>
  !!file &&
  !file.startsWith("/") &&
  !file.includes("\\") &&
  file.normalize("NFC") === file &&
  file.split("/").every((p) => p !== "" && p !== "." && p !== "..");
const validSpan = (s: unknown): s is NativeReferenceSpan => {
  if (typeof s !== "object" || s === null) return false;
  const span = s as Partial<NativeReferenceSpan>;
  return (
    typeof span.file === "string" &&
    validPath(span.file) &&
    Number.isSafeInteger(span.start) &&
    Number.isSafeInteger(span.end) &&
    span.start! >= 0 &&
    span.end! > span.start!
  );
};
const key = (s: NativeReferenceSpan): string => `${s.file}\0${s.start}\0${s.end}`;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const kindDifference = (kind: NativeFlowKind, rule: NativeRule): string | undefined => {
  if (rule.id !== "javascript-typescript/axios-to-fetch/v1") return undefined;
  const n = kind === "parsed-response" ? 1 : kind === "cancellation-propagation" ? 2 : 0;
  return rule.semanticDifferences[n];
};
/** Offset-shape validation, never a JavaScript AST or inferred control flow. */
function shape(kind: NativeFlowKind, text: string): boolean {
  if (kind === "status-check") return /\.(?:status|ok)$|\["(?:status|ok)"\]$/.test(text);
  if (kind === "parsed-response") return /\.data$|\["data"\]$/.test(text);
  if (kind === "error-handling")
    return /\.(?:code|response)$|\["(?:code|response)"\]$|^catch\s*\(/.test(text);
  if (kind === "cancellation-propagation")
    return /\bsignal\s*:|\bnew\s+AbortController\s*\(/.test(text);
  return /\bawait\b|\.then\s*\(/.test(text);
}
const within = (outer: NativeReferenceSpan, inner: NativeReferenceSpan): boolean =>
  outer.file === inner.file && inner.start >= outer.start && inner.end <= outer.end;
const name = /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u;
function tokenValid(kind: NativeFlowKind, token: string): boolean {
  if (kind === "response-handling") return /^await\s+$/u.test(token) || /^\.then$/u.test(token);
  if (kind === "status-check")
    return /^(?:\.(?:status|ok)|\[(["'])(?:status|ok)\1\])$/u.test(token);
  if (kind === "parsed-response") return /^(?:\.data|\[(["'])data\1\])$/u.test(token);
  if (kind === "error-handling") return /^catch\s*\(/u.test(token);
  return token === "signal" || token === '"signal"' || token === "'signal'";
}

/** Resolve the cited member's lexical symbol against the call-result declarator.
 * Matching spelling and bytes is not evidence that a nested use denotes it. */
async function sameLexicalResult(
  bytes: Uint8Array,
  declarationBinding: NativeReferenceSpan,
  occurrence: NativeReferenceSpan,
  member: NativeReferenceSpan,
): Promise<boolean> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const ts = (await import("typescript")).default;
  const sf = ts.createSourceFile(occurrence.file, text, ts.ScriptTarget.Latest, true);
  if (((sf as typeof sf & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length)
    return false;
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (file) => (file === occurrence.file ? sf : undefined);
  host.fileExists = (file) => file === occurrence.file;
  host.readFile = (file) => (file === occurrence.file ? text : undefined);
  const checker = ts
    .createProgram([occurrence.file], { noLib: true, noResolve: true }, host)
    .getTypeChecker();
  const matches = (node: TsNode, span: NativeReferenceSpan): boolean =>
    Buffer.byteLength(text.slice(0, node.getStart(sf))) === span.start &&
    Buffer.byteLength(text.slice(0, node.getEnd())) === span.end;
  let declared: TsNode | undefined;
  let used: TsNode | undefined;
  const visit = (node: TsNode): void => {
    if (ts.isIdentifier(node)) {
      if (matches(node, declarationBinding) && ts.isVariableDeclaration(node.parent))
        declared = node;
      if (
        matches(node, occurrence) &&
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node &&
        matches(node.parent, member)
      )
        used = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!declared || !used) return false;
  const declaredSymbol = checker.getSymbolAtLocation(declared);
  return !!declaredSymbol && declaredSymbol === checker.getSymbolAtLocation(used);
}

/** Offset-only ordered call argument coverage, matching the matched-API boundary. */
async function optionsCoverCall(
  call: NativeReferenceSpan,
  options: readonly NativeReferenceSpan[],
  read: (s: NativeReferenceSpan) => Promise<string | null>,
  kind: NativeFlowKind,
): Promise<boolean> {
  const text = await read(call);
  if (!text || !text.endsWith(")") || !Array.isArray(options)) return false;
  const open = text.indexOf("(");
  if (
    open < 0 ||
    !/^[\p{ID_Start}_$][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}$]*)*$/u.test(
      text.slice(0, open),
    )
  )
    return false;
  const base = Buffer.byteLength(text.slice(0, open + 1));
  const innerEnd = Buffer.byteLength(text) - 1;
  let cursor = base;
  for (const [i, span] of options.entries()) {
    if (
      !validSpan(span) ||
      span.file !== call.file ||
      span.start < call.start + base ||
      span.start < call.start + cursor ||
      span.end > call.start + innerEnd
    )
      return false;
    const gap = text.slice(cursor, span.start - call.start);
    if (!(i === 0 ? /^\s*$/u : /^\s*,\s*$/u).test(gap)) return false;
    if (kind === "cancellation-propagation") {
      const option = await read(span);
      if (!option) return false;
      // Any argument can carry an opaque config, including the first.
      const literal = /^(?:"[^"\\]*"|'[^'\\]*')$/u.test(option.trim());
      const object =
        /^\{[\s\S]*\}$/u.test(option.trim()) && !/\.\.\.|\[|\]|=>|\bfunction\b/u.test(option);
      if (!literal && !object) return false;
    }
    cursor = span.end - call.start;
  }
  return /^\s*$/u.test(text.slice(cursor, innerEnd));
}

/** Validate a complete lexical extent with the compiler parser but no checker.
 * Load it only inside this pillar to avoid affecting other language scans. */
async function wholeBlock(
  bytes: Uint8Array,
  scope: NativeReferenceSpan,
  call: NativeReferenceSpan,
  kind: NativeFlowKind,
): Promise<boolean> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const ts = (await import("typescript")).default;
  const sf = ts.createSourceFile(scope.file, text, ts.ScriptTarget.Latest, true);
  if (((sf as typeof sf & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length)
    return false;
  const toByte = (start: number, end: number): NativeReferenceSpan => ({
    file: scope.file,
    start: Buffer.byteLength(text.slice(0, start)),
    end: Buffer.byteLength(text.slice(0, end)),
  });
  let found = false;
  const visit = (node: TsNode): void => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const exact = toByte(node.getStart(sf), node.getEnd());
      if (key(exact) === key(scope) && within(scope, call)) {
        // A block is a valid negative boundary only if the call result cannot
        // escape it. A local parse without data-flow analysis cannot establish
        // that for a nested block, including const assigned to an outer name.
        // Restrict negatives to the complete function body or source file.
        if (
          ts.isSourceFile(node) ||
          (ts.isBlock(node) &&
            ts.isFunctionLike(node.parent) &&
            "body" in node.parent &&
            node.parent.body === node)
        ) {
          // A status/data negative is safe only for a local binding whose
          // every use is one directly inspected member read. Any bare value,
          // assignment, closure, return, or shadowed name is unresolved.
          if (kind === "status-check" || kind === "parsed-response") {
            let resultName: string | null = null;
            let declaration: TsNode | null = null;
            const locate = (child: TsNode): void => {
              if (
                ts.isVariableDeclaration(child) &&
                ts.isIdentifier(child.name) &&
                child.initializer &&
                within(toByte(child.initializer.getStart(sf), child.initializer.getEnd()), call)
              ) {
                resultName = child.name.text;
                declaration = child.name;
              }
              ts.forEachChild(child, locate);
            };
            locate(node);
            if (!resultName) return;
            let unsafe = false;
            const inspect = (child: TsNode): void => {
              if (child !== node && ts.isFunctionLike(child)) {
                if (child.getText(sf).includes(resultName!)) unsafe = true;
                return;
              }
              if (ts.isIdentifier(child) && child.text === resultName && child !== declaration) {
                const parent = child.parent;
                if (!(
                  (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
                  parent.expression === child &&
                  ((ts.isPropertyAccessExpression(parent) &&
                    ["status", "ok", "data"].includes(parent.name.text)) ||
                    (ts.isElementAccessExpression(parent) &&
                      ts.isStringLiteral(parent.argumentExpression) &&
                      ["status", "ok", "data"].includes(parent.argumentExpression.text)))
                ))
                  unsafe = true;
              }
              ts.forEachChild(child, inspect);
            };
            inspect(node);
            if (!unsafe) found = true;
          } else found = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export async function collectNativeSemanticEvidence(
  repository: RepositoryHandle,
  rule: NativeRule,
  snapshotSha256: string,
  uses: readonly NativeReferenceSpan[],
  records: readonly NativeFlowInspection[],
): Promise<NativeSemanticResult> {
  const checks: NativeSemanticCheck[] = [];
  const blocking: NativeSemanticBlock[] = [];
  let binding: "caller-asserted" | "verified" = "caller-asserted";
  let policy: string | null = null;
  const fail = (
    difference: string,
    reason: NativeSemanticBlock["reason"],
    call?: NativeReferenceSpan,
  ): void => {
    blocking.push({ difference, reason, ...(call ? { call } : {}) });
  };
  const result = (): NativeSemanticResult =>
    blocking.length
      ? {
          status: "blocked",
          snapshotSha256,
          binding,
          lineageVerification: "adapter-asserted",
          policy,
          checks,
          blocking: blocking as [NativeSemanticBlock, ...NativeSemanticBlock[]],
        }
      : {
          status: "pass",
          snapshotSha256,
          binding,
          lineageVerification: "core-reconstructed",
          policy,
          checks,
          blocking: [],
        };
  const first = await verifyNativeSnapshot(repository, snapshotSha256);
  if (first.status !== "verified") {
    fail("*", "snapshot-unverified");
    return result();
  }
  binding = "verified";
  policy = first.policy;
  let entries: Map<string, RepositoryTreeEntry>;
  try {
    const listing = await repository.listEntries?.();
    if (!listing?.complete || listing.limitations.length || listing.policy !== policy)
      throw Error();
    entries = new Map(listing.entries.filter((e) => e.kind === "file").map((e) => [e.path, e]));
  } catch {
    fail("*", "snapshot-unverified");
    return result();
  }
  const bytes = new Map<string, Uint8Array>();
  const proof = async (s: NativeReferenceSpan): Promise<NativeSourceProof | null> => {
    if (
      !s ||
      typeof s.file !== "string" ||
      !validPath(s.file) ||
      !entries.has(s.file) ||
      !Number.isSafeInteger(s.start) ||
      !Number.isSafeInteger(s.end) ||
      s.start < 0 ||
      s.end <= s.start
    )
      return null;
    let b = bytes.get(s.file);
    if (!b) {
      try {
        b = await repository.readFileBytes?.(s.file, entries.get(s.file));
      } catch {
        return null;
      }
      if (!(b instanceof Uint8Array)) return null;
      bytes.set(s.file, b);
    }
    if (s.end > b.length) return null;
    return {
      snapshotSha256,
      file: s.file,
      line: 1 + b.subarray(0, s.start).reduce((n, v) => n + (v === 10 ? 1 : 0), 0),
      span: { sha256: hash(b.subarray(s.start, s.end)) },
    };
  };
  const sourceBytes = async (span: NativeReferenceSpan): Promise<Uint8Array | null> =>
    (await proof(span)) ? (bytes.get(span.file)?.subarray(span.start, span.end) ?? null) : null;
  const decoded = async (span: NativeReferenceSpan): Promise<string | null> => {
    const value = await sourceBytes(span);
    if (!value) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return null;
    }
  };
  const files = new Set(entries.keys());
  const validateLink = async (
    record: NativeFlowInspection,
    call: NativeReferenceSpan,
    link: NativeFlowLink,
  ): Promise<NativeSemanticBlock["reason"] | null> => {
    if (
      !link ||
      typeof link.binding !== "string" ||
      !name.test(link.binding) ||
      !validSpan(link.span) ||
      !validSpan(link.bindingSpan) ||
      !validSpan(link.tokenSpan) ||
      !within(link.span, link.bindingSpan) ||
      !within(link.span, link.tokenSpan)
    )
      return "citation-inconsistent";
    const [region, bindingText, token] = await Promise.all([
      decoded(link.span),
      decoded(link.bindingSpan),
      decoded(link.tokenSpan),
    ]);
    if (!region || bindingText !== link.binding || !token || !tokenValid(record.kind, token))
      return "citation-inconsistent";
    // A byte-exact token alone is insufficient: the token must be contiguous
    // with its named binding for member flows, or belong to the cited call.
    if (
      ["status-check", "parsed-response"].includes(record.kind) &&
      (link.tokenSpan.start !== link.bindingSpan.end ||
        !/^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(bindingText))
    )
      return "association-unresolved";
    if (
      record.kind === "response-handling" &&
      (!within(link.span, call) || link.tokenSpan.end > call.start)
    )
      return "association-unresolved";
    if (
      record.kind === "error-handling" &&
      (!within(link.span, call) ||
        link.tokenSpan.start <= call.end ||
        !/\btry\s*\{[\s\S]*\bcatch\s*\(/u.test(region))
    )
      return "association-unresolved";
    if (
      !record.citations.some((s) => validSpan(s) && within(s, link.span)) ||
      !record.explored.some((s) => validSpan(s) && within(s, link.span))
    )
      return "incomplete-exploration";
    const tie = link.tie;
    if (!tie || tie.state !== "resolved") return "association-unresolved";
    if (
      !validSpan(tie.declaration) ||
      !validSpan(tie.declarationBinding) ||
      !within(tie.declaration, tie.declarationBinding) ||
      (await decoded(tie.declarationBinding)) !== link.binding ||
      !(await decoded(tie.declaration))
    )
      return "citation-inconsistent";
    const chain = record.lineageChain;
    if (!chain || !Array.isArray(chain.links) || !chain.links.length)
      return "association-unresolved";
    const finalLink = chain.links.at(-1);
    const terminalName = finalLink?.from ?? "";
    const lineage = await reconstructLineage(
      chain,
      rule.packages[0] ?? "",
      call,
      finalLink?.to ?? "",
      sourceBytes,
      files,
    );
    if (lineage.status !== "core-reconstructed") return "association-unresolved";
    if (tie.via === "call-site") {
      if (
        key(tie.declaration) !== key(call) ||
        !within(call, tie.declarationBinding) ||
        (await decoded(call))?.slice(0, tie.declarationBinding.end - call.start) !== link.binding ||
        !(terminalName === link.binding || terminalName.startsWith(link.binding + "."))
      )
        return "association-unresolved";
    } else if (tie.via === "call-result") {
      if (
        (record.kind === "status-check" || record.kind === "parsed-response") &&
        !(await sameLexicalResult(
          bytes.get(call.file)!,
          tie.declarationBinding,
          link.bindingSpan,
          link.span,
        ))
      )
        return "association-unresolved";
      const statement = await decoded(tie.declaration);
      const start = tie.declarationBinding.end - tie.declaration.start;
      const afterName = statement?.slice(start) ?? "";
      if (
        !within(tie.declaration, call) ||
        tie.declarationBinding.start !== tie.declaration.start ||
        !/^\s*=\s*(?:await\s+)?$/u.test(afterName.slice(0, call.start - tie.declarationBinding.end))
      )
        return "association-unresolved";
    } else if (tie.via === "call-option") {
      const statement = await decoded(tie.declaration);
      if (
        !within(call, link.span) ||
        !within(call, link.bindingSpan) ||
        link.tokenSpan.end >= link.bindingSpan.start ||
        !new RegExp(`^${link.binding}\\s*=\\s*new\\s+AbortController\\s*\\(`, "u").test(
          statement ?? "",
        )
      )
        return "association-unresolved";
    } else return "association-unresolved";
    return null;
  };
  const safeUses = Array.isArray(uses) ? uses : [];
  const safeRecords = Array.isArray(records) ? records : [];
  if (
    !safeUses.length ||
    safeUses.some((s) => !validSpan(s)) ||
    new Set(safeUses.filter(validSpan).map(key)).size !== safeUses.length ||
    !Array.isArray(rule.semanticDifferences) ||
    !rule.semanticDifferences.length ||
    new Set(rule.semanticDifferences).size !== rule.semanticDifferences.length
  )
    fail("*", "missing-flow");
  for (const call of safeUses.filter(validSpan)) {
    const useProof = await proof(call);
    if (!useProof) {
      fail("*", "citation-inconsistent", call);
      continue;
    }
    for (const difference of rule.semanticDifferences) {
      const needed = kinds.filter((kind) => kindDifference(kind, rule) === difference);
      const matching = safeRecords.filter(
        (r) => r?.difference === difference && validSpan(r.call) && key(r.call) === key(call),
      );
      const collected: NativeSourceProof[] = [];
      let state: NativeSemanticCheck["state"] = "inspected";
      let reason: NativeSemanticBlock["reason"] | null = null;
      if (
        !needed.length ||
        matching.length !== needed.length ||
        needed.some((kind) => matching.filter((r) => r.kind === kind).length !== 1)
      )
        reason = "missing-flow";
      for (const record of matching) {
        if (
          !["inspected-observed", "inspected-absent", "unknown"].includes(record?.state) ||
          (record.state === "unknown" && (!record.note || !record.note.trim()))
        ) {
          reason ??= "unknown";
          continue;
        }
        if (
          !kinds.includes(record.kind) ||
          kindDifference(record.kind, rule) !== difference ||
          !Array.isArray(record.citations) ||
          !Array.isArray(record.explored) ||
          !Array.isArray(record.lineage) ||
          [...record.lineage, ...record.explored, ...record.citations].some((s) => !validSpan(s))
        ) {
          reason = "citation-inconsistent";
          continue;
        }
        if (
          record.capped ||
          record.linksCapped ||
          (Array.isArray(record.links) && record.links.length > 8) ||
          record.explored.length > MAX_NODES ||
          !record.explored.some((s: NativeReferenceSpan) => key(s) === key(call))
        )
          reason = "incomplete-exploration";
        const all = [...record.lineage, ...record.explored, ...record.citations];
        const proven = await Promise.all(all.map(proof));
        if (
          proven.some((p) => !p) ||
          all.some(
            (s) =>
              s.file !== call.file &&
              !record.lineage.some((l: NativeReferenceSpan) => key(l) === key(s)),
          )
        ) {
          reason = "citation-inconsistent";
          continue;
        }
        for (const citation of record.citations) {
          const b = bytes.get(citation.file)!;
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              b.subarray(citation.start, citation.end),
            );
          } catch {
            reason = "citation-inconsistent";
            continue;
          }
          if (
            record.state === "inspected-observed" &&
            !shape(record.kind, text) &&
            !["status-check", "error-handling"].includes(record.kind)
          )
            reason = "citation-inconsistent";
          if (
            !record.explored.some(
              (s: NativeReferenceSpan) =>
                s.file === citation.file && s.start <= citation.start && s.end >= citation.end,
            )
          )
            reason = "incomplete-exploration";
        }
        if (!Array.isArray(record.links) || typeof record.linksCapped !== "boolean")
          reason ??= "association-unresolved";
        if (record.linksCapped) reason = "incomplete-links";
        if (record.state === "inspected-absent") {
          const negative = record.negativeProof;
          if (
            record.links?.length ||
            !negative ||
            !validSpan(negative.scope) ||
            !Array.isArray(negative.options) ||
            !Array.isArray(negative.inspected) ||
            !negative.inspected.length
          )
            reason ??= "absence-unreconstructed";
          else {
            const fields: NativeReferenceSpan[] = [
              negative.scope,
              ...negative.options,
              ...negative.inspected,
            ];
            const citedOptions = await Promise.all(negative.options.map(proof));
            const scopeText = await decoded(negative.scope);
            const optionText = await Promise.all(negative.options.map(decoded));
            const forbidden =
              record.kind === "status-check"
                ? /\b(?:status|ok)\b/u
                : record.kind === "parsed-response"
                  ? /\bdata\b/u
                  : record.kind === "error-handling"
                    ? /\bcatch\b/u
                    : record.kind === "cancellation-propagation"
                      ? /\b(?:signal|AbortController)\b/u
                      : /\b(?:await|then)\b/u;
            if (
              !within(negative.scope, call) ||
              !(await wholeBlock(
                bytes.get(negative.scope.file)!,
                negative.scope,
                call,
                record.kind,
              )) ||
              scopeText === null ||
              forbidden.test(scopeText) ||
              optionText.some((text) => text === null || forbidden.test(text)) ||
              fields.some((s) => !validSpan(s)) ||
              !(await proof(negative.scope)) ||
              citedOptions.some((p) => !p) ||
              !(await optionsCoverCall(call, negative.options, decoded, record.kind)) ||
              negative.inspected.some((s: NativeReferenceSpan) => !within(negative.scope, s)) ||
              negative.inspected.length !== record.explored.length ||
              !negative.inspected.some((s: NativeReferenceSpan) => key(s) === key(call)) ||
              negative.inspected.some(
                (s: NativeReferenceSpan, i: number) => key(s) !== key(record.explored[i]!),
              ) ||
              !record.citations.some((s: NativeReferenceSpan) => key(s) === key(negative.scope))
            )
              reason ??= "absence-unreconstructed";
          }
        } else {
          if (record.negativeProof) reason ??= "citation-inconsistent";
          for (const link of Array.isArray(record.links) ? record.links : []) {
            const issue = await validateLink(record, call, link);
            if (issue && !reason) reason = issue;
          }
          if (
            record.state === "inspected-observed" &&
            !(
              Array.isArray(record.links) &&
              record.links.length &&
              record.links.every((link: NativeFlowLink) => link.tie?.state === "resolved")
            )
          )
            reason ??= "association-unresolved";
        }
        if (record.state === "unknown")
          reason ??= record.note?.trim() ? "unknown" : "association-unresolved";
        collected.push(
          ...record.citations.map(
            (_: NativeReferenceSpan, i: number) =>
              proven[record.lineage.length + record.explored.length + i]!,
          ),
        );
        if (record.state === "unknown") state = "unknown";
      }
      if (reason || state !== "inspected" || !collected.length) {
        if (reason || !collected.length) state = "unknown";
        fail(difference, reason ?? "unknown", call);
      }
      checks.push({ difference, use: useProof, state, inspectedSource: collected });
    }
  }
  if (
    safeRecords.some(
      (r) =>
        !validSpan(r?.call) ||
        !safeUses.filter(validSpan).some((u) => key(u) === key(r.call)) ||
        !rule.semanticDifferences.includes(r.difference),
    )
  )
    fail("*", "missing-flow");
  const last = await verifyNativeSnapshot(repository, snapshotSha256);
  if (last.status !== "verified" || last.policy !== policy) {
    binding = "caller-asserted";
    policy = null;
    checks.length = 0;
    fail("*", "snapshot-unverified");
  }
  return result();
}
