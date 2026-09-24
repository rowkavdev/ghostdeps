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
  /** Imported names; "default" and "*" for default/namespace bindings, plus member names accessed on those bindings. */
  symbols: string[];
  /** `import type` / `export type` - erased at runtime. */
  typeOnly: boolean;
  /** True for `export ... from "x"` re-exports. */
  reExport: boolean;
  /** Set when a tsconfig/jsconfig alias resolved the specifier to a repository file (#29); packageName is then cleared. */
  aliased?: true;
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

function stringValue(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

export function scanSource(file: string, text: string): FileScanResult {
  const kind = scriptKindFor(file) ?? ts.ScriptKind.TS;
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

  const visit = (node: ts.Node): void => {
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
      } else if (
        ts.isIdentifier(callee) &&
        callee.text === "require" &&
        node.arguments.length >= 1
      ) {
        const spec = stringValue(arg);
        const ref = add(node, spec, spec === undefined ? "unknown" : "require", []);
        bindDeclaration(node, ref, "default");
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "require" &&
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
