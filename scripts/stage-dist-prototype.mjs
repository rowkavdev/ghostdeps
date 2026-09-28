#!/usr/bin/env node
/** Experimental CLI-only release layout. This does not change release.yml or stage-npm.mjs. */
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const versionIndex = process.argv.indexOf("--version");
const outIndex = process.argv.indexOf("--out");
const version = process.argv[versionIndex + 1];
if (versionIndex < 0 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ""))
  throw new Error("--version x.y.z is required");
const out = path.resolve(root, outIndex < 0 ? ".npm-dist-prototype" : process.argv[outIndex + 1]);
if (
  out === root ||
  !out.startsWith(root + path.sep) ||
  !path.basename(out).startsWith(".npm-dist-")
)
  throw new Error("staging output must be inside workspace");
const internal = new Map([
  ["@ghostdeps/core", "packages/core"],
  ["@ghostdeps/go", "packages/adapters/go"],
  ["@ghostdeps/javascript-typescript", "packages/adapters/javascript-typescript"],
  ["@ghostdeps/python", "packages/adapters/python"],
  ["@ghostdeps/rust", "packages/adapters/rust"],
]);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const files = [];
const collect = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(abs);
    else if (entry.isFile() && abs.endsWith(".js") && !abs.endsWith(".test.js")) files.push(abs);
  }
};
// Use TypeScript's emitted-JS AST and NodeNext resolver, not a textual replacement.
// TypeScript resolves workspace exports to .d.ts when declarations exist; we
// compare that target to the sibling emitted .js, which alone is shipped.
function rewrite(abs) {
  const source = readFileSync(abs, "utf8");
  const parsed = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const isWorker =
    path.relative(out, abs).split(path.sep).join("/") ===
    "dist/internal/core/engine/adapter-worker.js";
  const edits = [];
  const rewriteSpecifier = (literal) => {
    const specifier = literal.text;
    if (!specifier.startsWith("@ghostdeps/")) return;
    const [scope, name, ...subpath] = specifier.split("/");
    const packageName = `${scope}/${name}`;
    const workspace = internal.get(packageName);
    if (!workspace || subpath.length)
      throw new Error(`unmapped internal specifier in ${abs}: ${specifier}`);
    const pkg = readJson(path.join(root, workspace, "package.json"));
    const exportPath = pkg.exports?.["."]?.default;
    if (
      typeof exportPath !== "string" ||
      !exportPath.startsWith("./dist/") ||
      !exportPath.endsWith(".js")
    )
      throw new Error(`unmapped export: ${specifier}`);
    const stagedInternal = path.relative(path.join(out, "dist/internal"), abs).split(path.sep);
    const importingWorkspace = [...internal].find(
      ([key]) => key.slice("@ghostdeps/".length) === stagedInternal[0],
    )?.[1];
    const sourceAbs = importingWorkspace
      ? path.join(root, importingWorkspace, "dist", ...stagedInternal.slice(1))
      : path.join(root, "packages/cli/dist", path.relative(path.join(out, "dist"), abs));
    const resolved = ts.resolveModuleName(
      specifier,
      sourceAbs,
      { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
      ts.sys,
    ).resolvedModule;
    const expected = path.join(root, workspace, exportPath);
    if (
      !resolved ||
      path.resolve(resolved.resolvedFileName).replace(/\.d\.ts$/, ".js") !== expected ||
      !existsSync(expected)
    )
      throw new Error(`TypeScript could not resolve ${specifier} from ${abs}`);
    const target = path.join(out, "dist/internal", name, exportPath.slice("./dist/".length));
    if (!existsSync(target)) throw new Error(`missing staged target: ${specifier}`);
    let relative = path.relative(path.dirname(abs), target).split(path.sep).join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    edits.push({
      start: literal.getStart(parsed),
      end: literal.getEnd(),
      replacement: JSON.stringify(relative),
    });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        rewriteSpecifier(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments.length === 1
      ) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) rewriteSpecifier(arg);
        else if (!(
          isWorker &&
          source.slice(node.getStart(parsed), node.getEnd()) === "import(data.specifier)"
        ))
          throw new Error(`nonliteral dynamic module import in ${abs}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (isWorker) {
    const call = "import(data.specifier)";
    if (!source.includes(call) || source.split(call).length !== 2)
      throw new Error("worker import shape changed");
    const mapped = Object.fromEntries(
      [...internal.keys()]
        .filter((key) => key !== "@ghostdeps/core")
        .map((key) => [key, `../../${key.slice("@ghostdeps/".length)}/worker-entry.js`]),
    );
    // Worker input remains subject to core's analyzed-root guard. Only exact
    // bundled adapter names can be mapped; arbitrary worker imports fail.
    const helper = `const trustedAdapterEntries = ${JSON.stringify(mapped)};\nconst resolveTrustedAdapter = (name) => { if (!Object.hasOwn(trustedAdapterEntries, name)) throw new Error("unmapped worker adapter"); return trustedAdapterEntries[name]; };\n`;
    edits.push({ start: 0, end: 0, replacement: helper });
    const offset = source.indexOf(call);
    edits.push({
      start: offset,
      end: offset + call.length,
      replacement: "import(resolveTrustedAdapter(data.specifier))",
    });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  // Reparse output so no import/export/require literal names an unpublished package.
  const output = ts.createSourceFile(abs, result, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const verify = (node) => {
    const literal =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require"))
          ? node.arguments[0]
          : null;
    if (literal && ts.isStringLiteral(literal) && literal.text.startsWith("@ghostdeps/"))
      throw new Error(`unresolved internal specifier in ${abs}`);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      literal &&
      !ts.isStringLiteral(literal)
    ) {
      const allowedWorker =
        isWorker &&
        ts.isCallExpression(literal) &&
        ts.isIdentifier(literal.expression) &&
        literal.expression.text === "resolveTrustedAdapter" &&
        literal.arguments.length === 1;
      if (!allowedWorker) throw new Error(`unresolved dynamic import in ${abs}`);
    }
    ts.forEachChild(node, verify);
  };
  verify(output);
  writeFileSync(abs, result);
}
rmSync(out, { recursive: true, force: true });
for (const [name, workspace] of internal) {
  const src = path.join(root, workspace, "dist");
  if (!existsSync(path.join(src, "index.js"))) throw new Error(`missing built ${name}`);
  cpSync(src, path.join(out, "dist/internal", name.slice("@ghostdeps/".length)), {
    recursive: true,
    filter: (file) => !/\.test\.|\.d\.ts(?:\.map)?$|\.js\.map$/.test(file),
  });
}
cpSync(path.join(root, "packages/cli/dist"), path.join(out, "dist"), {
  recursive: true,
  filter: (file) => !/\.test\.|\.d\.ts(?:\.map)?$|\.js\.map$/.test(file),
});
collect(path.join(out, "dist"));
for (const file of files) rewrite(file);
// The isolated worker expects an adapter object, while the package indexes
// export factories. These fixed entries are the only names its mapping accepts.
const workerFactories = new Map([
  ["go", "createGoAdapter"],
  ["javascript-typescript", "createJavaScriptTypeScriptAdapter"],
  ["python", "createPythonAdapter"],
  ["rust", "createRustAdapter"],
]);
for (const [name, factory] of workerFactories) {
  const entry = path.join(out, "dist/internal", name, "worker-entry.js");
  writeFileSync(entry, `import { ${factory} } from "./index.js";\nexport default ${factory}();\n`);
}
// Keep the current peer-free WASM vendoring boundary. These are published
// registry packages, unlike the unpublished internal workspace modules.
const rustModules = path.join(root, "packages/adapters/rust/node_modules");
const grammar = realpathSync(path.join(rustModules, "tree-sitter-rust"));
const grammarOut = path.join(out, "node_modules/tree-sitter-rust");
mkdirSync(grammarOut, { recursive: true });
for (const file of ["tree-sitter-rust.wasm", "LICENSE"])
  copyFileSync(path.join(grammar, file), path.join(grammarOut, file));
const grammarPkg = readJson(path.join(grammar, "package.json"));
writeFileSync(
  path.join(grammarOut, "package.json"),
  JSON.stringify(
    {
      name: grammarPkg.name,
      version: grammarPkg.version,
      main: grammarPkg.main ?? "index.js",
      license: grammarPkg.license,
    },
    null,
    2,
  ) + "\n",
);
const webSource = realpathSync(path.join(rustModules, "web-tree-sitter"));
cpSync(webSource, path.join(out, "node_modules/web-tree-sitter"), {
  recursive: true,
  filter: (file) =>
    !/(^|[/\\])(node_modules|debug)([/\\]|$)/.test(path.relative(webSource, file)) &&
    !/\.d\.(?:ts|cts)(?:\.map)?$/.test(file),
});
if (!existsSync(path.join(out, "node_modules/web-tree-sitter/web-tree-sitter.wasm")))
  throw new Error("missing web-tree-sitter WASM");
const jsTs = readJson(path.join(root, "packages/adapters/javascript-typescript/package.json"));
const python = readJson(path.join(root, "packages/adapters/python/package.json"));
writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "ghost-deps",
      version,
      type: "module",
      license: "MIT",
      bin: { ghostdeps: "./dist/main.js" },
      engines: { node: ">=22" },
      files: ["dist"],
      bundledDependencies: ["tree-sitter-rust", "web-tree-sitter"],
      dependencies: {
        "smol-toml": python.dependencies["smol-toml"],
        typescript: jsTs.dependencies.typescript,
        yaml: jsTs.dependencies.yaml,
        "tree-sitter-rust": "0.24.0",
        "web-tree-sitter": "0.27.0",
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(`prototype staged ${files.length} emitted JS files in ${path.relative(root, out)}`);
