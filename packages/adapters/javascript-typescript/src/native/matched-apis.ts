/**
 * Source-backed matched-API reference producer (issue #443, #56 slice 4a).
 *
 * Parses JS/TS source with the TypeScript compiler in parse-only mode (no
 * Program, no type checker, nothing from the repository is ever evaluated -
 * ADR 0004) and emits typed reference records for every observable use of
 * one rule-relevant package: resolved binding lineage
 * (import -> alias -> wrapper -> re-export), call identity, argument/option
 * citations, and byte-exact UTF-8 spans.
 *
 * These records are CITATIONS, not verdicts. Slice 4b (#442, core side)
 * independently re-reads each cited span via the slice-3 verified binding
 * (readFileBytes + snapshot hash) before trusting it; this module never
 * hashes for core and never decides native eligibility.
 *
 * Honest-unknown rule: any use the producer cannot resolve to full depth is
 * emitted as resolution "indirect-unknown" with its location - never
 * dropped, never upgraded. Unknown downstream flows stay unknown.
 */
import ts from "typescript";
import { EXCLUDED_FILE_SUFFIXES, hasExcludedSegment } from "@ghostdeps/core";
import type { Evidence, RepositoryHandle } from "@ghostdeps/core";
import { parseSpecifier } from "../usage/specifier.js";
import { scriptKindFor, SCANNABLE_EXTENSIONS } from "../usage/scan.js";
import { MAX_SOURCE_BYTES } from "../usage/find-usage.js";
import { analyseScript, mentions, KNOWN_BINS } from "../references/scripts.js";
import { collectConfigReferences } from "../references/config.js";
import { isEmbeddedScriptFile } from "../usage/embedded.js";

/** Maximum call/alias/wrapper/re-export hops followed before giving up (cycle guard). */
export const MAX_RESOLUTION_DEPTH = 8;
/** Identifier-initialiser indirections followed when inspecting one argument. */
const MAX_INSPECT_DEPTH = 4;
/** Matched-API references emitted per scan; beyond this the scan blocks with a limitation. */
export const MAX_MATCHED_REFERENCES = 10_000;

/**
 * One byte-exact citation into a repository file: UTF-8 byte offsets, end
 * exclusive. Core re-reads exactly these bytes under the verified binding.
 */
export interface MatchedApiSpan {
  file: string;
  start: number;
  end: number;
}

/** The coverage classes the #56 definition names, plus the honest unknown. */
export type MatchedApiResolution =
  "direct" | "alias" | "wrapper" | "re-export" | "script" | "config" | "indirect-unknown";

/** One hop in a resolved binding lineage, outermost (nearest the package) first. */
export interface MatchedApiHop {
  kind: "import" | "require" | "alias" | "wrapper" | "re-export";
  /** The local name this hop binds (e.g. the alias, wrapper or barrel export name). */
  name: string;
  span: MatchedApiSpan;
}

/** One typed reference record for one observed use of the package. */
export interface MatchedApiReference {
  packageName: string;
  /** The local name actually invoked or referenced at this site. */
  binding: string;
  /** Semantic call target, e.g. "axios.get" - the same across aliases and wrappers. */
  callTarget: string;
  /** The API member observed, e.g. "get"; "<computed>" when not statically known. */
  api: string;
  resolution: MatchedApiResolution;
  /** Resolved lineage, outermost hop first; empty for script/config references. */
  lineage: MatchedApiHop[];
  /** "inspected" only when every argument node is a statically inspectable form. */
  arguments: "inspected" | "unknown";
  /**
   * "inspected" when there is no options-style trailing object argument, or
   * the trailing object is fully analyzable (no spread, no computed keys,
   * inspectable values). "unknown" whenever an options-style argument exists
   * but cannot be fully analyzed.
   */
  options: "inspected" | "unknown";
  /**
   * Byte span of the call expression, or of the manifest/config construct.
   * Absent only on an indirect-unknown record whose citation could not be
   * located at all; core must treat a missing span as blocking.
   */
  span?: MatchedApiSpan;
  /** One byte span per call argument, in order. Absent for script/config references. */
  argumentSpans?: MatchedApiSpan[];
  /** Producer note, e.g. why a record is indirect-unknown. */
  note?: string;
}

export interface MatchedApiScan {
  packageName: string;
  references: MatchedApiReference[];
  /** Everything that weakens completeness: skipped files, parse errors, unread configs. */
  limitations: Evidence[];
}

export interface MatchedApiOptions {
  /**
   * Extra CLI command names the package is invoked by in package.json
   * scripts, declared per package-rule (e.g. a rule knowing "axios-mock"
   * ships bin "axmock"). The package's own name (unscoped part for scoped
   * packages) and the well-known table in references/scripts.ts are always
   * tried. Script matching tokenises shell words; nothing is executed.
   */
  cliNames?: readonly string[];
}

/** UTF-8 byte length of one code point. */
function utf8Length(cp: number): number {
  return cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
}

/**
 * Code-unit offset -> UTF-8 byte offset for one file's text. TypeScript AST
 * positions are UTF-16 code units; core re-reads bytes, so every span is
 * converted exactly (astral characters count as one 4-byte code point).
 */
class ByteIndex {
  private readonly offsets: Uint32Array;
  constructor(text: string) {
    const offsets = new Uint32Array(text.length + 1);
    let byte = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          offsets[i + 1] = byte;
          byte += 4;
          offsets[i + 2] = byte;
          i += 1;
          continue;
        }
      }
      byte += utf8Length(code);
      offsets[i + 1] = byte;
    }
    this.offsets = offsets;
  }
  span(file: string, start: number, end: number): MatchedApiSpan {
    return { file, start: this.offsets[start]!, end: this.offsets[end]! };
  }
}

/** A local name bound (directly or transitively) to the package or one of its members. */
interface Binding {
  /** "namespace" binds the whole package object; "member" binds one exported member. */
  kind: "namespace" | "member";
  member?: string | undefined;
  /** The declaration node that created this binding (import clause or variable declaration). */
  decl: ts.Node;
  /** The top-level statement that introduced this binding; its names never shadow it. */
  declStatement?: ts.Node | undefined;
  hopKind: "import" | "require" | "alias";
  /** True when the local name differs from a plain direct import (alias class). */
  aliased: boolean;
  span: MatchedApiSpan;
  /**
   * Set when this binding arrives through a barrel re-export: the barrel's
   * export statement and the barrel file. Resolution is then "re-export".
   */
  barrel?: { file: string; exportSpan: MatchedApiSpan; star: boolean };
  /**
   * Set when the barrel chain could not be fully resolved (cycle or depth
   * limit): every call through this binding is indirect-unknown.
   */
  unresolved?: string;
}

/** What one file re-exports from the package or from another module. */
interface ReExportFacts {
  /** Exported local name -> source, for `export { x, y as z } from "..."`. */
  named: Map<string, { specifier: string; imported: string; span: MatchedApiSpan }>;
  /** `export * from "..."` statements. */
  star: { specifier: string; span: MatchedApiSpan }[];
}

interface WrapperInfo {
  name: string;
  /** The function node; its own declaration never shadows its name. */
  decl: ts.Node;
  span: MatchedApiSpan;
  /** The function body node; wrapper-graph edges are collected inside it. */
  body: ts.Node;
  /** Semantic call targets this wrapper's body invokes, e.g. ["axios.get"]. */
  targets: { callTarget: string; api: string; span: MatchedApiSpan; lineage: MatchedApiHop[] }[];
  /** Other local wrapper names this wrapper calls (graph edges). */
  callsWrappers: string[];
}

interface ParsedFile {
  file: string;
  text: string;
  sf: ts.SourceFile;
  index: ByteIndex;
}

/** Function-like nodes open a lexical scope frame (parameters shadow outer names). */
function isFunctionLikeNode(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isSkipped(path: string): boolean {
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true;
  return hasExcludedSegment(path);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

/** Candidate repo files for a relative import specifier, in resolution order. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".jsx"] as const;

function resolveRelative(
  specifier: string,
  fromDir: string,
  files: Set<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = fromDir === "." ? specifier.slice(2) : `${fromDir}/${specifier.slice(2)}`;
  const normalised = base.replace(/\/\.\//g, "/").replace(/^\.\//, "");
  const candidates = [normalised];
  for (const ext of RESOLVE_EXTENSIONS) {
    if (normalised.endsWith(ext)) return files.has(normalised) ? normalised : undefined;
    candidates.push(`${normalised}${ext}`, `${normalised}/index${ext}`);
  }
  // A .js/.mjs/.cjs specifier may name a .ts/.tsx sibling (NodeNext).
  const stripped = normalised.replace(/\.(?:mjs|cjs|js|jsx)$/, "");
  if (stripped !== normalised) {
    for (const ext of RESOLVE_EXTENSIONS) candidates.push(`${stripped}${ext}`);
  }
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

/** Statically inspectable argument forms; everything else makes arguments "unknown". */
function inspectable(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  depth: number,
): boolean {
  if (ts.isParenthesizedExpression(node)) return inspectable(node.expression, consts, depth);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return inspectable(node.expression, consts, depth);
  }
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    default:
      break;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isTemplateExpression(node)) {
    // Interpolated values are inspectable only if every part is.
    return node.templateSpans.every((span) => inspectable(span.expression, consts, depth));
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every(
      (el) =>
        !ts.isSpreadElement(el) && !ts.isOmittedExpression(el) && inspectable(el, consts, depth),
    );
  }
  if (ts.isObjectLiteralExpression(node)) return objectInspectable(node, consts, depth);
  if (ts.isIdentifier(node)) {
    if (node.text === "undefined") return true;
    if (depth >= MAX_INSPECT_DEPTH) return false;
    const init = consts.get(node.text);
    return init !== undefined && inspectable(init, consts, depth + 1);
  }
  return false;
}

/** An options object is inspectable only with no spread, no computed keys and inspectable values. */
function objectInspectable(
  node: ts.ObjectLiteralExpression,
  consts: Map<string, ts.Expression>,
  depth: number,
): boolean {
  if (depth >= MAX_INSPECT_DEPTH) return false;
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) return false;
    if (ts.isShorthandPropertyAssignment(prop)) {
      const init = consts.get(prop.name.text);
      if (init === undefined || !inspectable(init, consts, depth + 1)) return false;
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) return false;
    if (ts.isComputedPropertyName(prop.name)) return false;
    if (!inspectable(prop.initializer, consts, depth + 1)) return false;
  }
  return true;
}

/**
 * Find every reference to `packageName` in the repository: package-bound
 * call expressions in JS/TS source, package.json script invocations of the
 * package CLI, and parsed config constructs. Reads files through the
 * read-only RepositoryHandle only; never executes or resolves anything.
 */
export async function findMatchedApiReferences(
  repository: RepositoryHandle,
  packageName: string,
  options: MatchedApiOptions = {},
): Promise<MatchedApiScan> {
  const limitations: Evidence[] = [];
  const references: MatchedApiReference[] = [];
  let overflow = false;
  const push = (ref: MatchedApiReference): void => {
    if (references.length >= MAX_MATCHED_REFERENCES) {
      overflow = true;
      return;
    }
    references.push(ref);
  };

  const all = (await repository.listFiles()).map((f) => f.replace(/^\.\//, ""));
  const fileSet = new Set(all);
  const sourceFiles = all.filter((f) => {
    if (isSkipped(f)) return false;
    if (isEmbeddedScriptFile(f)) return false;
    return scriptKindFor(f) !== undefined && SCANNABLE_EXTENSIONS.some((ext) => f.endsWith(ext));
  });
  const embedded = all.filter((f) => !isSkipped(f) && isEmbeddedScriptFile(f));
  if (embedded.length > 0) {
    limitations.push({
      kind: "matched-api-embedded-unscanned",
      statement: `${embedded.length} embedded-script file(s) (e.g. ${embedded[0] ?? "unknown"}) were not analysed for matched-API references; coverage is incomplete`,
      ...(embedded[0] !== undefined ? { file: embedded[0] } : {}),
    });
  }

  // Parse pass: one AST per file, with byte-offset conversion.
  const parsed = new Map<string, ParsedFile>();
  for (const file of sourceFiles) {
    let text: string;
    try {
      text = await repository.readFile(file);
    } catch {
      limitations.push({
        kind: "matched-api-file-unreadable",
        statement: `${file} could not be read; matched-API coverage is incomplete`,
        file,
      });
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
      limitations.push({
        kind: "matched-api-file-oversized",
        statement: `${file} exceeds the ${MAX_SOURCE_BYTES}-byte parse cap and was not analysed`,
        file,
      });
      continue;
    }
    const kind = scriptKindFor(file) ?? ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    parsed.set(file, { file, text, sf, index: new ByteIndex(text) });
  }

  // Fact pass: bindings, re-export facts, local consts, wrapper candidates.
  const bindingsByFile = new Map<string, Map<string, Binding>>();
  const reExportsByFile = new Map<string, ReExportFacts>();
  const constsByFile = new Map<string, Map<string, ts.Expression>>();
  const wrappersByFile = new Map<string, Map<string, WrapperInfo>>();

  const packageOf = (specifier: string | undefined): string | undefined => {
    if (specifier === undefined) return undefined;
    const parsedSpecifier = parseSpecifier(specifier);
    return parsedSpecifier.kind === "package" ? parsedSpecifier.packageName : undefined;
  };

  for (const { file, sf, index } of parsed.values()) {
    const bindings = new Map<string, Binding>();
    const reExports: ReExportFacts = { named: new Map(), star: [] };
    const consts = new Map<string, ts.Expression>();
    bindingsByFile.set(file, bindings);
    reExportsByFile.set(file, reExports);
    constsByFile.set(file, consts);

    const spanOf = (node: ts.Node): MatchedApiSpan =>
      index.span(file, node.getStart(sf), node.getEnd());

    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        if (packageOf(specifier) !== packageName) continue;
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const span = spanOf(statement);
        if (clause.name) {
          // Default import binds the package's default export (its object).
          bindings.set(clause.name.text, {
            kind: "namespace",
            decl: clause.name,
            hopKind: "import",
            aliased: false,
            span,
          });
        }
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named)) {
          bindings.set(named.name.text, {
            kind: "namespace",
            decl: named.name,
            hopKind: "import",
            aliased: false,
            span,
          });
        } else if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (element.isTypeOnly) continue;
            const imported = (element.propertyName ?? element.name).text;
            const local = element.name.text;
            bindings.set(local, {
              kind: imported === "default" ? "namespace" : "member",
              member: imported === "default" ? undefined : imported,
              decl: element,
              hopKind: "import",
              aliased: element.propertyName !== undefined,
              span,
            });
          }
        }
        continue;
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier.text;
        const span = spanOf(statement);
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (element.isTypeOnly) continue;
            const imported = (element.propertyName ?? element.name).text;
            reExports.named.set(element.name.text, { specifier, imported, span });
          }
        } else if (!clause) {
          reExports.star.push({ specifier, span });
        }
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const decl of statement.declarationList.declarations) {
          if (!decl.initializer) continue;
          // require("pkg") bindings.
          if (
            ts.isCallExpression(decl.initializer) &&
            ts.isIdentifier(decl.initializer.expression) &&
            decl.initializer.expression.text === "require" &&
            decl.initializer.arguments.length === 1 &&
            ts.isStringLiteralLike(decl.initializer.arguments[0]!)
          ) {
            const specifier = decl.initializer.arguments[0].text;
            if (packageOf(specifier) !== packageName) continue;
            const span = spanOf(decl);
            if (ts.isIdentifier(decl.name)) {
              bindings.set(decl.name.text, {
                kind: "namespace",
                decl,
                hopKind: "require",
                aliased: false,
                span,
              });
            } else if (ts.isObjectBindingPattern(decl.name)) {
              for (const element of decl.name.elements) {
                if (!ts.isIdentifier(element.name)) continue;
                const imported = (
                  element.propertyName && ts.isIdentifier(element.propertyName)
                    ? element.propertyName
                    : element.name
                ).text;
                bindings.set(element.name.text, {
                  kind: "member",
                  member: imported,
                  decl: element,
                  hopKind: "require",
                  aliased: true,
                  span,
                });
              }
            }
            continue;
          }
          const init = decl.initializer;
          if (!isConst) {
            // let/var alias of a package binding: reassignable, so the
            // binding cannot be proven to still reference the package. Keep
            // it as an unresolved alias - calls through it emit
            // indirect-unknown rather than vanishing.
            if (ts.isIdentifier(decl.name)) {
              const target = ts.isIdentifier(init)
                ? bindings.get(init.text)
                : ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)
                  ? bindings.get(init.expression.text)
                  : undefined;
              if (target) {
                bindings.set(decl.name.text, {
                  ...target,
                  decl,
                  hopKind: "alias",
                  aliased: true,
                  span: spanOf(decl),
                  unresolved:
                    "reassignable alias (let/var) cannot be proven to still reference the package",
                });
              }
            }
            continue;
          }
          // Destructure alias: const { get: g } = <namespace binding>.
          if (ts.isObjectBindingPattern(decl.name) && ts.isIdentifier(init)) {
            const target = bindings.get(init.text);
            if (target?.kind === "namespace") {
              for (const element of decl.name.elements) {
                if (!ts.isIdentifier(element.name)) continue;
                const imported = (
                  element.propertyName && ts.isIdentifier(element.propertyName)
                    ? element.propertyName
                    : element.name
                ).text;
                bindings.set(element.name.text, {
                  kind: "member",
                  member: imported,
                  decl: element,
                  hopKind: "alias",
                  aliased: true,
                  span: spanOf(decl),
                });
              }
            }
            continue;
          }
          if (!ts.isIdentifier(decl.name)) continue;
          const name = decl.name.text;
          // Local consts feed argument inspection.
          consts.set(name, init);
          // Alias: const ax = <namespace binding>.
          if (ts.isIdentifier(init)) {
            const target = bindings.get(init.text);
            if (target) {
              bindings.set(name, {
                ...target,
                decl,
                hopKind: "alias",
                aliased: true,
                span: spanOf(decl),
              });
            }
            continue;
          }
          // Member alias: const g = <namespace binding>.get.
          if (
            ts.isPropertyAccessExpression(init) &&
            ts.isIdentifier(init.expression) &&
            bindings.get(init.expression.text)?.kind === "namespace"
          ) {
            bindings.set(name, {
              kind: "member",
              member: init.name.text,
              decl,
              hopKind: "alias",
              aliased: true,
              span: spanOf(decl),
            });
            continue;
          }
        }
      }
    }
  }

  // Backfill declStatement: the enclosing statement of each binding's declaration.
  const statementOf = (node: ts.Node): ts.Node => {
    let current = node;
    while (
      current.parent &&
      !ts.isSourceFile(current.parent) &&
      !ts.isBlock(current.parent) &&
      !ts.isModuleBlock(current.parent) &&
      !ts.isCaseBlock(current.parent)
    ) {
      current = current.parent;
    }
    return current;
  };
  for (const bindings of bindingsByFile.values()) {
    for (const binding of bindings.values()) {
      binding.declStatement = statementOf(binding.decl);
    }
  }

  // Resolve barrel re-export chains into bindings on the importing files.
  for (const { file, sf, index } of parsed.values()) {
    const bindings = bindingsByFile.get(file)!;
    const resolveBarrel = (
      fromFile: string,
      exportName: string,
      depth: number,
    ):
      | { imported: string; exportSpan: MatchedApiSpan; star: boolean }
      | { unresolved: string }
      | undefined => {
      if (depth > MAX_RESOLUTION_DEPTH) return { unresolved: "re-export chain depth limit" };
      const facts = reExportsByFile.get(fromFile);
      if (!facts) return undefined;
      const named = facts.named.get(exportName);
      if (named) {
        if (packageOf(named.specifier) === packageName) {
          return { imported: named.imported, exportSpan: named.span, star: false };
        }
        if (named.specifier.startsWith(".")) {
          const next = resolveRelative(named.specifier, dirname(fromFile), fileSet);
          if (next !== undefined) {
            const inner = resolveBarrel(next, named.imported, depth + 1);
            if (inner && "unresolved" in inner) return inner;
            if (inner) return inner;
          }
        }
        return undefined;
      }
      if (facts.star.length > 0) {
        for (const star of facts.star) {
          if (packageOf(star.specifier) === packageName) {
            return { imported: exportName, exportSpan: star.span, star: true };
          }
          if (star.specifier.startsWith(".")) {
            const next = resolveRelative(star.specifier, dirname(fromFile), fileSet);
            if (next !== undefined) {
              const inner = resolveBarrel(next, exportName, depth + 1);
              if (inner && "unresolved" in inner) return inner;
              if (inner) return { ...inner, star: true };
            }
          }
        }
        return { unresolved: `export * in ${fromFile} could not be traced to ${packageName}` };
      }
      return undefined;
    };

    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelative(specifier, dirname(file), fileSet);
      if (target === undefined) continue;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const importSpan = index.span(file, statement.getStart(sf), statement.getEnd());
      const bind = (local: string, exportName: string): void => {
        const resolved = resolveBarrel(target, exportName, 0);
        if (!resolved) return;
        const barrel = {
          file: target,
          exportSpan: "unresolved" in resolved ? importSpan : resolved.exportSpan,
          star: "unresolved" in resolved ? false : resolved.star,
        };
        if ("unresolved" in resolved) {
          bindings.set(local, {
            kind: "member",
            member: exportName,
            decl: statement,
            hopKind: "import",
            aliased: false,
            span: importSpan,
            barrel,
            unresolved: resolved.unresolved,
          });
          return;
        }
        bindings.set(local, {
          kind: resolved.imported === "default" ? "namespace" : "member",
          member: resolved.imported === "default" ? undefined : resolved.imported,
          decl: statement,
          hopKind: "import",
          aliased: exportName !== resolved.imported,
          span: importSpan,
          barrel,
        });
      };
      if (clause.name) bind(clause.name.text, "default");
      const named = clause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          bind(element.name.text, (element.propertyName ?? element.name).text);
        }
      } else if (named && ts.isNamespaceImport(named)) {
        // import * as ns from "./barrel": member access is resolved per call below.
        const resolved = resolveBarrel(target, "*", 0);
        if (resolved && !("unresolved" in resolved)) {
          bindings.set(named.name.text, {
            kind: "namespace",
            decl: named.name,
            hopKind: "import",
            aliased: false,
            span: importSpan,
            barrel: { file: target, exportSpan: resolved.exportSpan, star: resolved.star },
          });
        }
      }
    }
  }

  // Call pass: resolve every call expression; collect wrappers; emit records.
  //
  // Fail-closed contract: every observable use of a tracked binding yields
  // either a full-depth reference or an explicit indirect-unknown with
  // location and note. Silent drops are bugs.
  for (const { file, sf, index } of parsed.values()) {
    const bindings = bindingsByFile.get(file)!;
    const consts = constsByFile.get(file)!;
    const wrappers = new Map<string, WrapperInfo>();
    wrappersByFile.set(file, wrappers);
    const spanOf = (node: ts.Node): MatchedApiSpan =>
      index.span(file, node.getStart(sf), node.getEnd());

    // Lexical scope frames: parameters and let/const/var/function/class
    // declarations, each with the textual span it governs. A use of a
    // package binding's name inside a frame that redeclares that name is
    // shadowed: resolution is defeated and the use is indirect-unknown,
    // never a false direct citation. Import names are never frame members;
    // a binding's own declaration node is excluded from its shadow check.
    interface ScopeFrame {
      start: number;
      end: number;
      names: Map<string, ts.Node[]>;
    }
    const frames: ScopeFrame[] = [];
    {
      const bindingStatements = new Set<ts.Node>();
      for (const binding of bindings.values()) {
        if (binding.declStatement) bindingStatements.add(binding.declStatement);
      }
      const stack: ScopeFrame[] = [];
      const pushFrame = (node: ts.Node): void => {
        const frame: ScopeFrame = {
          start: node.getStart(sf),
          end: node.getEnd(),
          names: new Map(),
        };
        frames.push(frame);
        stack.push(frame);
      };
      const addDecl = (name: string, decl: ts.Node): void => {
        const frame = stack[stack.length - 1];
        if (!frame) return;
        const list = frame.names.get(name) ?? [];
        list.push(decl);
        frame.names.set(name, list);
      };
      const addPattern = (name: ts.BindingName, decl: ts.Node): void => {
        if (ts.isIdentifier(name)) {
          addDecl(name.text, decl);
          return;
        }
        for (const element of name.elements) {
          if (!ts.isOmittedExpression(element)) addPattern(element.name, decl);
        }
      };
      const buildFrames = (node: ts.Node): void => {
        const fn = isFunctionLikeNode(node);
        if (ts.isFunctionDeclaration(node) && node.name) {
          // A function declaration's name belongs to the OUTER scope.
          addDecl(node.name.text, node);
        }
        const own =
          fn ||
          ts.isBlock(node) ||
          ts.isForStatement(node) ||
          ts.isForInStatement(node) ||
          ts.isForOfStatement(node) ||
          ts.isCatchClause(node) ||
          ts.isModuleBlock(node) ||
          ts.isCaseBlock(node) ||
          node === sf;
        if (own) pushFrame(node);
        if (fn) {
          for (const param of node.parameters) addPattern(param.name, param);
        }
        if (ts.isCatchClause(node) && node.variableDeclaration) {
          addPattern(node.variableDeclaration.name, node.variableDeclaration);
        }
        if (ts.isVariableDeclaration(node) && !bindingStatements.has(statementOf(node))) {
          addPattern(node.name, node);
        }
        if (ts.isClassDeclaration(node) && node.name) addDecl(node.name.text, node);
        if (ts.isImportDeclaration(node)) {
          // Import names are bindings, not shadowing declarations.
          if (own) stack.pop();
          return;
        }
        ts.forEachChild(node, buildFrames);
        if (own) stack.pop();
      };
      buildFrames(sf);
    }
    const isShadowed = (name: string, pos: number, exclude?: ts.Node): boolean => {
      for (const frame of frames) {
        if (pos < frame.start || pos >= frame.end) continue;
        const decls = frame.names.get(name);
        if (decls?.some((decl) => decl !== exclude)) return true;
      }
      return false;
    };

    interface Resolved {
      binding: Binding;
      localName: string;
      api: string;
      callTarget: string;
      hops: MatchedApiHop[];
      computed?: true;
    }

    type Callee =
      | { status: "ok"; resolved: Resolved }
      | {
          status: "unknown";
          reason: string;
          localName: string;
          hops: MatchedApiHop[];
          api?: string;
        }
      | { status: "unrelated" };

    const hopsFor = (binding: Binding): MatchedApiHop[] => {
      const hops: MatchedApiHop[] = [];
      if (binding.barrel) {
        hops.push({
          kind: "re-export",
          name: binding.member ?? "default",
          span: binding.barrel.exportSpan,
        });
      }
      hops.push({ kind: binding.hopKind, name: binding.member ?? "default", span: binding.span });
      return hops;
    };

    /**
     * Resolve a callee expression to a package-derived target, an honest
     * unknown, or proof the call does not touch the tracked bindings.
     */
    const resolveCallee = (expr: ts.Expression, depth: number): Callee => {
      if (depth > MAX_RESOLUTION_DEPTH) {
        return {
          status: "unknown",
          reason: "callee resolution depth limit; the invoked API cannot be determined statically",
          localName: expr.getText(sf),
          hops: [],
        };
      }
      if (ts.isIdentifier(expr)) {
        const binding = bindings.get(expr.text);
        if (!binding) return { status: "unrelated" };
        if (isShadowed(expr.text, expr.getStart(sf), binding.decl)) {
          return {
            status: "unknown",
            reason: `"${expr.text}" is shadowed by a local declaration here; provenance of this use cannot be proven`,
            localName: expr.text,
            hops: hopsFor(binding),
          };
        }
        if (binding.kind === "namespace") {
          return {
            status: "ok",
            resolved: {
              binding,
              localName: expr.text,
              api: "",
              callTarget: packageName,
              hops: hopsFor(binding),
            },
          };
        }
        return {
          status: "ok",
          resolved: {
            binding,
            localName: expr.text,
            api: binding.member ?? "",
            callTarget: `${packageName}.${binding.member ?? ""}`,
            hops: hopsFor(binding),
          },
        };
      }
      if (ts.isPropertyAccessExpression(expr)) {
        const base = resolveCallee(expr.expression, depth + 1);
        if (base.status === "unrelated") return base;
        if (base.status === "unknown") {
          return { ...base, localName: expr.name.text };
        }
        if (base.resolved.api !== "") {
          return {
            status: "unknown",
            reason:
              "member-of-member chain on a package binding; full API lineage cannot be proven",
            localName: expr.name.text,
            hops: base.resolved.hops,
          };
        }
        return {
          status: "ok",
          resolved: {
            ...base.resolved,
            localName: expr.name.text,
            api: expr.name.text,
            callTarget: `${packageName}.${expr.name.text}`,
          },
        };
      }
      if (ts.isElementAccessExpression(expr)) {
        const base = resolveCallee(expr.expression, depth + 1);
        if (base.status === "unrelated") return base;
        if (base.status === "unknown") return base;
        return {
          status: "unknown",
          reason:
            "computed or non-static member access on a package binding; the invoked API cannot be determined statically",
          localName: base.resolved.localName,
          hops: base.resolved.hops,
          api: "<computed>",
        };
      }
      // Parenthesized / as-cast callees unwrap; anything else derived from a
      // package binding (call results, sequences, tagged templates) is an
      // unknown flow when the base is package-related.
      if (
        ts.isParenthesizedExpression(expr) ||
        ts.isAsExpression(expr) ||
        ts.isSatisfiesExpression(expr)
      ) {
        return resolveCallee(expr.expression, depth + 1);
      }
      return { status: "unrelated" };
    };

    const resolutionFor = (resolved: Resolved): MatchedApiResolution => {
      if (resolved.computed || resolved.binding.unresolved) return "indirect-unknown";
      if (resolved.binding.barrel) return "re-export";
      if (resolved.binding.aliased || resolved.binding.hopKind === "alias") return "alias";
      return "direct";
    };

    const inspectArguments = (
      node: ts.CallExpression,
    ): { argsState: "inspected" | "unknown"; optionsState: "inspected" | "unknown" } => {
      let argsState: "inspected" | "unknown" = "inspected";
      for (const arg of node.arguments) {
        if (ts.isSpreadElement(arg) || !inspectable(arg, consts, 0)) {
          argsState = "unknown";
          break;
        }
      }
      let optionsState: "inspected" | "unknown" = "inspected";
      const last = node.arguments[node.arguments.length - 1];
      if (last && node.arguments.length > 1) {
        if (ts.isObjectLiteralExpression(last)) {
          optionsState = objectInspectable(last, consts, 0) ? "inspected" : "unknown";
        } else if (ts.isIdentifier(last)) {
          const init = consts.get(last.text);
          optionsState =
            init && ts.isObjectLiteralExpression(init) && objectInspectable(init, consts, 0)
              ? "inspected"
              : "unknown";
        } else if (
          !ts.isSpreadElement(last) &&
          (ts.isCallExpression(last) || ts.isPropertyAccessExpression(last))
        ) {
          optionsState = "unknown";
        }
      }
      return { argsState, optionsState };
    };

    const emitCall = (node: ts.CallExpression): void => {
      const callee = resolveCallee(node.expression, 0);
      if (callee.status === "unrelated") return;
      const span = spanOf(node);
      const argumentSpans = node.arguments.map((arg) => spanOf(arg));
      const { argsState, optionsState } = inspectArguments(node);
      if (callee.status === "unknown") {
        push({
          packageName,
          binding: callee.localName,
          callTarget: packageName,
          api: callee.api ?? "<unresolved>",
          resolution: "indirect-unknown",
          lineage: callee.hops,
          arguments: argsState,
          options: optionsState,
          span,
          argumentSpans,
          note: callee.reason,
        });
        return;
      }
      const { resolved } = callee;
      const resolution = resolutionFor(resolved);
      // A bare call of the namespace binding (axios(...)) is the package's
      // callable API, not a missing member.
      const api = resolved.api === "" ? "<call>" : resolved.api;
      push({
        packageName,
        binding: resolved.localName,
        callTarget: resolved.callTarget,
        api,
        resolution,
        lineage: resolved.hops,
        arguments: argsState,
        options: optionsState,
        span,
        argumentSpans,
        ...(resolution === "indirect-unknown"
          ? {
              note:
                resolved.binding.unresolved ??
                "computed or non-static member access on a package binding; the invoked API cannot be determined statically",
            }
          : {}),
      });
    };

    // Wrapper collection: local functions whose body calls the package.
    const functionName = (node: ts.Node): string | undefined => {
      if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
      ) {
        return node.parent.name.text;
      }
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
      return undefined;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        // Dynamic import of the package: the binding flow through the
        // promise/await cannot be tracked statically, so every such site is
        // an honest unknown - never upgraded to direct.
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteralLike(node.arguments[0]!) &&
          packageOf(node.arguments[0].text) === packageName
        ) {
          push({
            packageName,
            binding: "import()",
            callTarget: packageName,
            api: "<dynamic-import>",
            resolution: "indirect-unknown",
            lineage: [{ kind: "import", name: "import()", span: spanOf(node) }],
            arguments: "unknown",
            options: "unknown",
            span: spanOf(node),
            note: "dynamic import binding flow is not tracked; downstream uses stay unknown",
          });
        } else {
          emitCall(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    const bodyCallsPackage = (
      body: ts.Node,
    ): { callTarget: string; api: string; span: MatchedApiSpan; lineage: MatchedApiHop[] }[] => {
      const out: {
        callTarget: string;
        api: string;
        span: MatchedApiSpan;
        lineage: MatchedApiHop[];
      }[] = [];
      const seen = new Set<number>();
      const inner = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && !seen.has(node.getStart(sf))) {
          seen.add(node.getStart(sf));
          const callee = resolveCallee(node.expression, 0);
          if (callee.status === "ok" && callee.resolved.api !== "") {
            out.push({
              callTarget: callee.resolved.callTarget,
              api: callee.resolved.api,
              span: spanOf(node),
              lineage: callee.resolved.hops,
            });
          }
        }
        ts.forEachChild(node, inner);
      };
      inner(body);
      return out;
    };

    // Candidates: every named local function. A function is a wrapper when
    // its body calls the package OR calls another wrapper (the graph is a
    // fixpoint - a wrapper of a wrapper is still a wrapper).
    interface Candidate {
      name: string;
      decl: ts.Node;
      span: MatchedApiSpan;
      body: ts.Node;
      targets: WrapperInfo["targets"];
      calls: string[];
    }
    const candidates = new Map<string, Candidate>();
    const collectCandidates = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)
      ) {
        const name = functionName(node);
        const body = node.body;
        if (name && body && !candidates.has(name)) {
          const calls: string[] = [];
          const findCalls = (inner: ts.Node): void => {
            if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
              calls.push(inner.expression.text);
            }
            ts.forEachChild(inner, findCalls);
          };
          findCalls(body);
          candidates.set(name, {
            name,
            decl: node,
            span: spanOf(node),
            body,
            targets: ts.isBlock(body) || ts.isExpression(body) ? bodyCallsPackage(body) : [],
            calls,
          });
        }
      }
      ts.forEachChild(node, collectCandidates);
    };
    collectCandidates(sf);
    const wrapperNames = new Set<string>();
    for (;;) {
      let grew = false;
      for (const candidate of candidates.values()) {
        if (wrapperNames.has(candidate.name)) continue;
        if (
          candidate.targets.length > 0 ||
          candidate.calls.some((callee) => callee !== candidate.name && wrapperNames.has(callee))
        ) {
          wrapperNames.add(candidate.name);
          grew = true;
        }
      }
      if (!grew) break;
    }
    for (const name of wrapperNames) {
      const candidate = candidates.get(name)!;
      wrappers.set(name, {
        name,
        decl: candidate.decl,
        span: candidate.span,
        body: candidate.body,
        targets: candidate.targets,
        callsWrappers: candidate.calls.filter(
          (callee) => callee !== name && wrapperNames.has(callee),
        ),
      });
    }

    // Calls to wrapper names resolve through the wrapper graph. A wrapper
    // name shadowed at the call site is indirect-unknown, never a wrapper
    // citation.
    const emitWrapperCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const start = wrappers.get(name);
        if (start && !bindings.has(name)) {
          const span = spanOf(node);
          const argumentSpans = node.arguments.map((arg) => spanOf(arg));
          const { argsState, optionsState } = inspectArguments(node);
          if (isShadowed(name, node.expression.getStart(sf), start.decl)) {
            push({
              packageName,
              binding: name,
              callTarget: packageName,
              api: "<unresolved>",
              resolution: "indirect-unknown",
              lineage: [{ kind: "wrapper", name, span: start.span }],
              arguments: argsState,
              options: optionsState,
              span,
              argumentSpans,
              note: `"${name}" is shadowed by a local declaration here; provenance of this use cannot be proven`,
            });
          } else {
            const chain = (
              current: WrapperInfo,
              depth: number,
              acc: MatchedApiHop[],
            ): { targets: WrapperInfo["targets"]; hops: MatchedApiHop[] } | { cycle: true } => {
              if (depth > MAX_RESOLUTION_DEPTH) return { cycle: true };
              const hops = [
                ...acc,
                { kind: "wrapper" as const, name: current.name, span: current.span },
              ];
              const targets = [...current.targets];
              const subHops: MatchedApiHop[] = [];
              for (const calleeName of current.callsWrappers) {
                const next = wrappers.get(calleeName);
                if (!next) continue;
                const resolved = chain(next, depth + 1, hops);
                if ("cycle" in resolved) return resolved;
                targets.push(...resolved.targets);
                subHops.push(...resolved.hops.slice(hops.length));
              }
              return { targets, hops: [...hops, ...subHops] };
            };
            const resolved = chain(start, 0, []);
            if ("cycle" in resolved) {
              push({
                packageName,
                binding: name,
                callTarget: packageName,
                api: "<unresolved>",
                resolution: "indirect-unknown",
                lineage: [{ kind: "wrapper", name, span: start.span }],
                arguments: "unknown",
                options: "unknown",
                span,
                argumentSpans,
                note: "wrapper graph cycle or depth limit; downstream flow stays unknown",
              });
            } else {
              for (const target of resolved.targets) {
                push({
                  packageName,
                  binding: name,
                  callTarget: target.callTarget,
                  api: target.api,
                  resolution: "wrapper",
                  lineage: [...resolved.hops, ...target.lineage],
                  arguments: argsState,
                  options: optionsState,
                  span,
                  argumentSpans,
                  note: `local wrapper "${name}" resolves to ${target.callTarget}`,
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, emitWrapperCalls);
    };
    // The wrapper's inner package call is emitted by emitCall as a direct
    // record; wrapper-call SITES are distinct nodes emitted here as wrapper
    // records. Both are kept: a dropped flow is worse than a cited one.
    emitWrapperCalls(sf);
  }

  // package.json script references: evidence from manifest bytes, never executed.
  const cliNames = new Set<string>([
    packageName.startsWith("@") ? (packageName.split("/")[1] ?? packageName) : packageName,
    ...(KNOWN_BINS[packageName] ?? []),
    ...(options.cliNames ?? []),
  ]);
  for (const file of all) {
    if (!file.endsWith("package.json") || isSkipped(file)) continue;
    let text: string;
    try {
      text = await repository.readFile(file);
    } catch {
      limitations.push({
        kind: "matched-api-manifest-unreadable",
        statement: `${file} could not be read; script coverage is incomplete`,
        file,
      });
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      limitations.push({
        kind: "matched-api-manifest-malformed",
        statement: `${file} is not parseable JSON; script coverage is incomplete`,
        file,
      });
      continue;
    }
    if (typeof doc !== "object" || doc === null) continue;
    const scripts = (doc as Record<string, unknown>).scripts;
    if (typeof scripts !== "object" || scripts === null) continue;
    const index = new ByteIndex(text);
    for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof command !== "string") continue;
      const invoked =
        analyseScript(command).words.some((word) => cliNames.has(word)) ||
        mentions(command, packageName).length > 0;
      if (!invoked) continue;
      // Citation: the script entry's string value in the manifest bytes.
      // The reference was decided by the parsed manifest; this only locates
      // the exact bytes of that construct so core can re-read them.
      const keyNeedle = JSON.stringify(name);
      const valueNeedle = JSON.stringify(command);
      const keyAt = text.indexOf(keyNeedle);
      const valueAt = keyAt < 0 ? -1 : text.indexOf(valueNeedle, keyAt + keyNeedle.length);
      if (valueAt < 0) {
        push({
          packageName,
          binding: name,
          callTarget: packageName,
          api: "<script>",
          resolution: "indirect-unknown",
          lineage: [],
          arguments: "unknown",
          options: "unknown",
          note: `script "${name}" invokes the package CLI but its manifest bytes could not be located for citation`,
        });
        continue;
      }
      push({
        packageName,
        binding: name,
        callTarget: packageName,
        api: "<script>",
        resolution: "script",
        lineage: [],
        arguments: "inspected",
        options: "inspected",
        span: index.span(file, valueAt, valueAt + valueNeedle.length),
        note: `package.json script "${name}" invokes the package CLI`,
      });
    }
  }

  // Config references: parsed as constructs by references/config.ts (never
  // string matching); the span cites the construct line the parser named.
  const config = await collectConfigReferences(repository, ".", all);
  for (const unreadItem of config.unread) {
    limitations.push({
      kind: "matched-api-config-unread",
      statement: `config ${unreadItem.file} is unread (${unreadItem.reason}); config coverage is incomplete`,
      file: unreadItem.file,
    });
  }
  const configTexts = new Map<string, { text: string; index: ByteIndex }>();
  for (const ref of config.refs) {
    if (ref.via !== "config") continue; // conventions are usage evidence, not matched-API constructs.
    if (!ref.packages.includes(packageName)) continue;
    let cached = configTexts.get(ref.file);
    if (!cached) {
      try {
        const text = await repository.readFile(ref.file);
        cached = { text, index: new ByteIndex(text) };
        configTexts.set(ref.file, cached);
      } catch {
        limitations.push({
          kind: "matched-api-config-unreadable",
          statement: `config ${ref.file} could not be re-read for citation; config coverage is incomplete`,
          file: ref.file,
        });
        continue;
      }
    }
    const lines = cached.text.split("\n");
    const lineText = lines[ref.line - 1] ?? "";
    const lineStart = lines.slice(0, ref.line - 1).reduce((n, l) => n + l.length + 1, 0);
    const first = lineText.search(/\S/);
    if (first < 0) {
      push({
        packageName,
        binding: ref.source,
        callTarget: packageName,
        api: "<config>",
        resolution: "indirect-unknown",
        lineage: [],
        arguments: "unknown",
        options: "unknown",
        note: `config reference (${ref.source}) has no locatable construct bytes`,
      });
      continue;
    }
    push({
      packageName,
      binding: ref.source,
      callTarget: packageName,
      api: "<config>",
      resolution: "config",
      lineage: [],
      arguments: "inspected",
      options: "inspected",
      span: cached.index.span(ref.file, lineStart + first, lineStart + lineText.length),
      note: `config construct (${ref.source}) references the package; line-granular construct citation`,
    });
  }

  if (overflow) {
    limitations.push({
      kind: "matched-api-reference-overflow",
      statement: `more than ${MAX_MATCHED_REFERENCES} matched-API references; the scan is incomplete`,
    });
  }
  return { packageName, references, limitations };
}
