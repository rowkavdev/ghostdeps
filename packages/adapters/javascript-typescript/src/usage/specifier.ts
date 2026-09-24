/**
 * Map a module specifier (the string in `import "x"` / `require("x")`) to the
 * npm package it names. Pure string logic: nothing is resolved on disk and
 * nothing is fetched.
 */
import { builtinModules } from "node:module";

export type SpecifierKind =
  /** A bare specifier naming an npm package, e.g. "lodash/get" -> "lodash". */
  | "package"
  /** A Node.js built-in, e.g. "fs" or "node:fs". */
  | "builtin"
  /** A relative or absolute path, e.g. "./util" or "/abs/path". */
  | "relative"
  /** A package.json "imports" subpath, e.g. "#internal/x". */
  | "subpath-import"
  /** A URL or other scheme, e.g. "https://esm.sh/x", "data:...", "bun:test". */
  | "url"
  /** Not a valid npm package name (e.g. "@/components" path aliases). */
  | "invalid";

export interface ParsedSpecifier {
  kind: SpecifierKind;
  /** Package name for kind "package" (e.g. "@scope/pkg"), else undefined. */
  packageName?: string;
  /** Subpath inside the package, e.g. "get" for "lodash/get". */
  subpath?: string;
}

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

// npm's rules (validate-npm-package-name, "new packages" subset, relaxed to
// accept legacy uppercase names): URL-safe characters, no leading dot,
// underscore or tilde ("~/x" is a common path alias), 214 chars max.
const NAME_PART = /^[a-zA-Z0-9-][a-zA-Z0-9._~-]*$/;
const MAX_NAME_LENGTH = 214;

export function parseSpecifier(specifier: string): ParsedSpecifier {
  const spec = specifier.trim();
  if (spec === "" || spec.length > 4096) return { kind: "invalid" };
  if (spec.startsWith(".") || spec.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(spec)) {
    return { kind: "relative" };
  }
  if (spec.startsWith("#")) return { kind: "subpath-import" };
  if (spec.startsWith("node:")) return { kind: "builtin" };
  // Any "scheme:" prefix (https:, data:, file:, bun:, npm:, jsr:, virtual: ...).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return { kind: "url" };

  const parts = spec.split("/");
  let name: string;
  let rest: string[];
  if (spec.startsWith("@")) {
    const scope = parts[0]!.slice(1);
    const pkg = parts[1];
    if (!scope || !pkg || !NAME_PART.test(scope) || !NAME_PART.test(pkg)) {
      return { kind: "invalid" };
    }
    name = `@${scope}/${pkg}`;
    rest = parts.slice(2);
  } else {
    name = parts[0]!;
    rest = parts.slice(1);
    if (!NAME_PART.test(name)) return { kind: "invalid" };
    if (BUILTINS.has(name) || BUILTINS.has(spec)) return { kind: "builtin" };
  }
  if (name.length > MAX_NAME_LENGTH) return { kind: "invalid" };
  const subpath = rest.join("/");
  return subpath
    ? { kind: "package", packageName: name, subpath }
    : { kind: "package", packageName: name };
}
