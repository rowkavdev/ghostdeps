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
const MAX_STRINGS_PER_FILE = 20_000;
const MAX_STRING_CHARS = 100_000;

/**
 * A whole string that is a package subpath: "pkg/", "pkg/sub/file.js",
 * "@scope/pkg" or "@scope/pkg/sub". Bare unscoped words ("debug", "url") are
 * too common in ordinary strings to count.
 */
const SUBPATH_LITERAL =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*(?:\/[^\s'"`]*)?|[a-z0-9-~][a-z0-9-._~]*\/[^\s'"`]*)$/i;

/** `import "x"`, `from "x"` and `require("x")` inside string or template text. */
const CODE_SPECIFIER =
  /\b(?:import|from)\s*["']([^"'\s]{1,300})["']|\brequire\(\s*["']([^"'\s]{1,300})["']\s*\)/g;

function stringValue(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
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

  /** `createRequire(...)` / `module.createRequire(...)`, which returns a require function. */
  const isCreateRequire = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === "createRequire") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "createRequire"));

  // Names bound to a require function: `require` itself plus
  // `const r = createRequire(import.meta.url)`. Scoping is not tracked; a
  // shadowed name can only add a reference, never hide one.
  const requireNames = new Set(["require"]);
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
  if (text.includes("createRequire")) findRequireAliases(sf);

  /** A callee that behaves like `require`: a require name, or `createRequire(...)` called directly. */
  const isRequireFunction = (callee: ts.Node): boolean =>
    (ts.isIdentifier(callee) && requireNames.has(callee.text)) || isCreateRequire(callee);

  /** String text seen in the file, checked for package references after the import pass. */
  const strings: { node: ts.Node; text: string }[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (strings.length < MAX_STRINGS_PER_FILE) strings.push({ node, text: node.text });
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
      const callee = node.expression;
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
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        isRequireFunction(callee.expression) &&
        callee.name.text === "resolve" &&
        node.arguments.length >= 1
      ) {
        const spec = stringValue(arg);
        add(node, spec, spec === undefined ? "unknown" : "require", ["require.resolve"]);
      }
    }
    ts.forEachChild(node, visit);
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
  for (const { node, text } of strings) {
    if (text.length > MAX_STRING_CHARS) continue;
    if (SUBPATH_LITERAL.test(text)) addString(node, text);
    CODE_SPECIFIER.lastIndex = 0;
    for (
      let m = CODE_SPECIFIER.exec(text), n = 0;
      m && n < 50;
      m = CODE_SPECIFIER.exec(text), n++
    ) {
      addString(node, (m[1] ?? m[2])!);
    }
  }

  // Second pass: member names accessed on default/namespace/require bindings,
  // e.g. `axios.get(...)` adds "get". Shadowing is not tracked; this can only
  // add symbols to an existing reference, never create a usage.
  if (bindings.size > 0) {
    const collect = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        for (const ref of bindings.get(node.expression.text) ?? []) {
          if (!ref.symbols.includes(node.name.text)) ref.symbols.push(node.name.text);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
  }

  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  return { file, references, parseErrors: Array.isArray(diagnostics) && diagnostics.length > 0 };
}
