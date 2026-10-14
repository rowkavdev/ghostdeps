/**
 * Static import scanning for one JS/TS source file.
 *
 * Uses the TypeScript compiler API in parse-only mode (`ts.createSourceFile`):
 * no Program, no type checker, no module resolution, and nothing from the
 * repository is ever evaluated (ADR 0004).
 */
import ts from "typescript";
import { parseSpecifier } from "./specifier.js";
import type { Usage } from "@ghostdeps/core";

/** One import-like reference found in a file. */
export interface ImportReference {
  /** The raw specifier, or undefined when it could not be read statically. */
  specifier?: string;
  /** Package name when the specifier names an npm package. */
  packageName?: string;
  form: Usage["form"];
  /** 1-based line of the import/require/import() expression. */
  line: number;
  /** 1-based last line of that expression (multi-line imports). */
  endLine?: number;
  /** Imported names; "default" and "*" for default/namespace bindings, plus member names accessed on those bindings. */
  symbols: string[];
  /** `import type` / `export type` - erased at runtime. */
  typeOnly: boolean;
  /** True for `export ... from "x"` re-exports. */
  reExport: boolean;
  /** Set when a tsconfig/jsconfig alias resolved the specifier to a repository file (#29); packageName is then cleared. */
  aliased?: true;
  /**
   * Found in string text rather than an import: a package subpath literal
   * ("regenerator-runtime/runtime.js", "core-js/") or an import/require
   * inside a string or template (generated code). form is "unknown".
   */
  stringReference?: true;
}

export interface FileScanResult {
  file: string;
  references: ImportReference[];
  /** True when the parser reported syntax errors; results may be partial. */
  parseErrors: boolean;
  /**
   * String evidence the scan did not examine (string count, string length or match
   * limits), so string-only package references may be missing. Absent when every
   * string was examined. Reported as a usage limitation, never as an absence.
   */
  incompleteStrings?: string[];
}

const EXTENSION_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

/** File extensions the scanner understands. `.d.ts` files are included (they can import types). */
export const SCANNABLE_EXTENSIONS = Object.keys(EXTENSION_KINDS);

export function scriptKindFor(file: string): ts.ScriptKind | undefined {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXTENSION_KINDS[file.slice(dot).toLowerCase()];
}

/** String literals examined per file, and the longest one examined. */
export const MAX_STRINGS_PER_FILE = 20_000;
export const MAX_STRING_CHARS = 100_000;
/** Code-specifier matches read from one string. */
export const MAX_SPECIFIER_MATCHES_PER_STRING = 50;

/**
 * A whole string that is a package subpath: "pkg/", "pkg/sub/file.js",
 * "@scope/pkg" or "@scope/pkg/sub". Bare unscoped words ("debug", "url") are
 * too common in ordinary strings to count.
 */
const SUBPATH_LITERAL =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*(?:\/[^\s'"`]*)?|[a-z0-9-~][a-z0-9-._~]*\/[^\s'"`]*)$/i;

/**
 * Test-framework module factories whose first argument names a dependency:
 * jest.mock/doMock/unmock/dontMock/deepUnmock/requireActual/requireMock/
 * createMockFromModule/genMockFromModule/setMock and
 * vi.mock/doMock/unmock/doUnmock. Scoping is not tracked; a user object named
 * `jest` or `vi` can only add a usage reference, never remove one.
 */
const MOCK_SPECIFIER_CALLS: Record<string, ReadonlySet<string>> = {
  jest: new Set([
    "mock",
    "doMock",
    "unmock",
    "dontMock",
    "deepUnmock",
    "requireActual",
    "requireMock",
    "createMockFromModule",
    "genMockFromModule",
    "setMock",
  ]),
  vi: new Set(["mock", "doMock", "unmock", "doUnmock"]),
};
/**
 * Async Vitest imports whose first argument names a dependency:
 * vi.importActual and vi.importMock resolve the module at runtime like a
 * dynamic import, so they are recorded with the dynamic form.
 */
const MOCK_DYNAMIC_CALLS: Record<string, ReadonlySet<string>> = {
  vi: new Set(["importActual", "importMock"]),
};

/** `import "x"`, `from "x"` and `require("x")` inside string or template text. */
const CODE_SPECIFIER =
  /\b(?:import|from)\s*["']([^"'\s]{1,300})["']|\brequire\(\s*["']([^"'\s]{1,300})["']\s*\)/g;

function stringValue(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

/** Records a string literal for the string-reference pass; false when the per-file limit was already reached. */
function collectString(
  strings: { node: ts.Node; text: string }[],
  node: ts.StringLiteralLike | ts.TemplateLiteralToken,
): boolean {
  if (strings.length >= MAX_STRINGS_PER_FILE) return false;
  strings.push({ node, text: node.text });
  return true;
}

/** Names each kind of string evidence the scan left unexamined; empty when every string was examined. */
function describeIncompleteStrings(
  overflow: boolean,
  longStrings: number,
  matchCapped: number,
): string[] {
  const out: string[] = [];
  if (overflow) out.push(`more than ${MAX_STRINGS_PER_FILE} string literals`);
  if (longStrings > 0) {
    out.push(
      `${longStrings} string${longStrings === 1 ? "" : "s"} over ${MAX_STRING_CHARS} characters`,
    );
  }
  if (matchCapped > 0) {
    out.push(
      `${matchCapped} string${matchCapped === 1 ? "" : "s"} with more than ${MAX_SPECIFIER_MATCHES_PER_STRING} specifier-like matches`,
    );
  }
  return out;
}

export function scanSource(file: string, text: string, scriptKind?: ts.ScriptKind): FileScanResult {
  const kind = scriptKind ?? scriptKindFor(file) ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const references: ImportReference[] = [];
  /** Local binding name -> references it was bound from (for member-access symbols). */
  const bindings = new Map<string, ImportReference[]>();

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const add = (
    node: ts.Node,
    specifier: string | undefined,
    form: Usage["form"],
    symbols: string[],
    opts: { typeOnly?: boolean; reExport?: boolean } = {},
  ): ImportReference => {
    const ref: ImportReference = {
      form,
      line: lineOf(node),
      endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      symbols,
      typeOnly: opts.typeOnly ?? false,
      reExport: opts.reExport ?? false,
    };
    if (specifier !== undefined) {
      ref.specifier = specifier;
      const parsed = parseSpecifier(specifier);
      if (parsed.kind === "package" && parsed.packageName) ref.packageName = parsed.packageName;
    }
    references.push(ref);
    return ref;
  };

  const bind = (name: string, ref: ImportReference) => {
    const list = bindings.get(name) ?? [];
    list.push(ref);
    bindings.set(name, list);
  };

  /** Record names bound by `const <pattern> = require(...)` / `await import(...)`. */
  const bindPattern = (name: ts.BindingName, ref: ImportReference, whole: string) => {
    if (ts.isIdentifier(name)) {
      ref.symbols.push(whole);
      bind(name.text, ref);
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const prop = el.propertyName ?? el.name;
        if (el.dotDotDotToken) ref.symbols.push("*");
        else if (ts.isIdentifier(prop) || ts.isStringLiteral(prop)) ref.symbols.push(prop.text);
      }
    }
  };

  /** If `call` is the initializer of a variable declaration (optionally awaited), bind it. */
  const bindDeclaration = (call: ts.Node, ref: ImportReference, whole: string) => {
    let node: ts.Node = call;
    while (
      node.parent &&
      (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent))
    ) {
      node = node.parent;
    }
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node) {
      bindPattern(parent.name, ref, whole);
    } else if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      // require("x").foo / (await import("x")).foo
      ref.symbols.push(parent.name.text);
    }
  };

  /** Strips grouping parentheses only; sequences, conditionals and type wrappers stay as they are. */
  const unwrapParens = (node: ts.Node): ts.Node => {
    let current = node;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };

  /** Member name of `x.name` or `x["name"]`, ignoring grouping parentheses; undefined for any other callee. */
  const memberName = (node: ts.Node): string | undefined => {
    const callee = unwrapParens(node);
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isElementAccessExpression(callee)) {
      const key = callee.argumentExpression;
      if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
    }
    return undefined;
  };

  /** `createRequire(...)` / `module.createRequire(...)` / `module["createRequire"](...)`, which returns a require function. */
  // Local names a `createRequire` import from node:module/module is bound to
  // (`import { createRequire as makeRequire }`). Scoping is not tracked; a shadowed
  // name can only add a reference, never hide one.
  const factoryNames = new Set<string>();
  const isCreateRequire = (value: ts.Node): boolean => {
    const node = unwrapParens(value);
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrapParens(node.expression);
    return (
      (ts.isIdentifier(callee) &&
        (callee.text === "createRequire" || factoryNames.has(callee.text))) ||
      memberName(callee) === "createRequire"
    );
  };

  // Names bound to a require function: `require` itself plus
  // `const r = createRequire(import.meta.url)`. Scoping is not tracked; a
  // shadowed name can only add a reference, never hide one.
  const requireNames = new Set(["require"]);
  const findFactoryImports = (statements: ts.NodeArray<ts.Statement>): void => {
    for (const statement of statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const from = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if ((from !== "node:module" && from !== "module") || !clause || clause.isTypeOnly) continue;
      const named = clause.namedBindings;
      if (!named || !ts.isNamedImports(named)) continue;
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        if ((element.propertyName ?? element.name).text === "createRequire") {
          factoryNames.add(element.name.text);
        }
      }
    }
  };
  const findRequireAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCreateRequire(node.initializer)
    ) {
      requireNames.add(node.name.text);
    }
    ts.forEachChild(node, findRequireAliases);
  };
  // Raw-text fast path. An identifier or string spelled with an escape sequence does not
  // contain the word createRequire, so a file with any backslash-u or backslash-x escape
  // also takes the walk.
  if (text.includes("createRequire") || /\\[ux]/.test(text)) {
    findFactoryImports(sf.statements);
    findRequireAliases(sf);
  }

  /** A callee that behaves like `require`: a require name, or `createRequire(...)` called directly. */
  const isRequireFunction = (value: ts.Node): boolean => {
    const callee = unwrapParens(value);
    return (ts.isIdentifier(callee) && requireNames.has(callee.text)) || isCreateRequire(callee);
  };

  /** String text seen in the file, checked for package references after the import pass. */
  const strings: { node: ts.Node; text: string }[] = [];

  let stringsOverflow = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (!collectString(strings, node)) stringsOverflow = true;
    }
    if (ts.isImportDeclaration(node)) {
      const spec = stringValue(node.moduleSpecifier);
      const clause = node.importClause;
      const symbols: string[] = [];
      const ref = add(node, spec, "static", symbols, { typeOnly: clause?.isTypeOnly ?? false });
      if (clause?.name) {
        symbols.push("default");
        bind(clause.name.text, ref);
      }
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        symbols.push("*");
        bind(nb.name.text, ref);
      } else if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) symbols.push((el.propertyName ?? el.name).text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = stringValue(node.moduleSpecifier);
      const symbols: string[] = [];
      if (!node.exportClause) symbols.push("*");
      else if (ts.isNamespaceExport(node.exportClause)) symbols.push("*");
      else
        for (const el of node.exportClause.elements)
          symbols.push((el.propertyName ?? el.name).text);
      add(node, spec, "static", symbols, { typeOnly: node.isTypeOnly, reExport: true });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const spec = stringValue(node.moduleReference.expression);
      const ref = add(node, spec, "require", ["default"], { typeOnly: node.isTypeOnly });
      bind(node.name.text, ref);
    } else if (ts.isImportTypeNode(node)) {
      // `typeof import("x")` / `import("x").Foo` in type positions.
      const arg = node.argument;
      const spec = ts.isLiteralTypeNode(arg) ? stringValue(arg.literal) : undefined;
      const symbols = node.qualifier ? [node.qualifier.getText(sf).split(".")[0]!] : ["*"];
      add(node, spec, "static", symbols, { typeOnly: true });
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapParens(node.expression);
      const arg = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const ref = add(
          node,
          stringValue(arg),
          stringValue(arg) === undefined ? "unknown" : "dynamic",
          [],
        );
        bindDeclaration(node, ref, "*");
      } else if (isRequireFunction(callee) && node.arguments.length >= 1) {
        const spec = stringValue(arg);
        const ref = add(node, spec, spec === undefined ? "unknown" : "require", []);
        bindDeclaration(node, ref, "default");
      } else if (memberName(callee) !== undefined && node.arguments.length >= 1) {
        // `x.name(...)` and `x["name"](...)` name the member the same way; a computed
        // name that is not a plain string stays unmatched.
        const target = unwrapParens(
          (callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression,
        );
        const member = memberName(callee)!;
        const spec = stringValue(arg);
        if (isRequireFunction(target) && member === "resolve") {
          add(node, spec, spec === undefined ? "unknown" : "require", ["require.resolve"]);
        } else if (
          ts.isMetaProperty(target) &&
          target.keywordToken === ts.SyntaxKind.ImportKeyword &&
          target.name.text === "meta" &&
          member === "resolve"
        ) {
          // `import.meta.resolve("x")`: ESM resolution reference.
          add(node, spec, spec === undefined ? "unknown" : "require", ["import.meta.resolve"]);
        } else if (
          ts.isIdentifier(target) &&
          Object.hasOwn(MOCK_SPECIFIER_CALLS, target.text) &&
          MOCK_SPECIFIER_CALLS[target.text]?.has(member)
        ) {
          // `jest.mock("x")` / `vi.mock("x")` and counterparts: the first
          // argument names a dependency resolved at runtime.
          add(node, spec, spec === undefined ? "unknown" : "require", [`${target.text}.${member}`]);
        } else if (
          ts.isIdentifier(target) &&
          Object.hasOwn(MOCK_DYNAMIC_CALLS, target.text) &&
          MOCK_DYNAMIC_CALLS[target.text]?.has(member)
        ) {
          // `await vi.importActual("x")` / `await vi.importMock("x")`: an
          // asynchronous import of the named module.
          add(node, spec, spec === undefined ? "unknown" : "dynamic", [`${target.text}.${member}`]);
        }
      }
    }
    // JSDoc is not part of forEachChild. In JavaScript files it carries real
    // type dependencies: `@type {import("x").Foo}`, `@typedef`, `@import`.
    if (isJavaScriptKind) {
      const docs = (node as ts.Node & { jsDoc?: ts.Node[] }).jsDoc;
      if (docs) for (const doc of docs) visitDoc(doc);
    }
    ts.forEachChild(node, visit);
  };
  const isJavaScriptKind = kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
  const visitDoc = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) {
      visit(node);
      return;
    }
    // TypeScript 5.5+ `@import {X} from "x"` tag.
    const tag = node as ts.Node & {
      moduleSpecifier?: ts.Expression;
      importClause?: ts.ImportClause;
    };
    if (node.kind === ts.SyntaxKind.JSDocImportTag && tag.moduleSpecifier) {
      const symbols: string[] = [];
      const clause = tag.importClause;
      if (clause?.name) symbols.push("default");
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) symbols.push("*");
      else if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements) symbols.push((el.propertyName ?? el.name).text);
      add(node, stringValue(tag.moduleSpecifier), "static", symbols, { typeOnly: true });
      return;
    }
    ts.forEachChild(node, visitDoc);
  };
  visit(sf);

  // String references (#172, vite plugin-legacy): packages a module names in
  // string text, typically code it generates or resolves for a bundle. They
  // only ever add usage. Real import specifiers are also string literals, so
  // anything already found on the same line is not repeated.
  const seen = new Set(references.map((r) => `${r.line}:${r.packageName ?? ""}`));
  const addString = (node: ts.Node, specifier: string) => {
    const parsed = parseSpecifier(specifier);
    if (parsed.kind !== "package" || !parsed.packageName) return;
    const key = `${lineOf(node)}:${parsed.packageName}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ref = add(node, specifier, "unknown", []);
    ref.stringReference = true;
  };
  let longStrings = 0;
  let matchCapped = 0;
  for (const { node, text } of strings) {
    if (text.length > MAX_STRING_CHARS) {
      longStrings++;
      continue;
    }
    if (SUBPATH_LITERAL.test(text)) addString(node, text);
    CODE_SPECIFIER.lastIndex = 0;
    let m = CODE_SPECIFIER.exec(text);
    for (let n = 0; m && n < MAX_SPECIFIER_MATCHES_PER_STRING; n++) {
      addString(node, (m[1] ?? m[2])!);
      m = CODE_SPECIFIER.exec(text);
    }
    // A match left after the limit is one that was never read.
    if (m) matchCapped++;
  }
  const incompleteStrings = describeIncompleteStrings(stringsOverflow, longStrings, matchCapped);

  // Second pass: member names accessed on default/namespace/require bindings,
  // e.g. `axios.get(...)` adds "get". Shadowing is not tracked; this can only
  // add symbols to an existing reference, never create a usage.
  if (bindings.size > 0) {
    // Keep output order in the array, but do not rescan it for every member.
    const symbolSets = new Map<ImportReference, Set<string>>();
    const collect = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        for (const ref of bindings.get(node.expression.text) ?? []) {
          let symbols = symbolSets.get(ref);
          if (symbols === undefined) {
            symbols = new Set(ref.symbols);
            symbolSets.set(ref, symbols);
          }
          if (!symbols.has(node.name.text)) {
            symbols.add(node.name.text);
            ref.symbols.push(node.name.text);
          }
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
  }

  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  return {
    file,
    references,
    parseErrors: Array.isArray(diagnostics) && diagnostics.length > 0,
    ...(incompleteStrings.length > 0 ? { incompleteStrings } : {}),
  };
}
