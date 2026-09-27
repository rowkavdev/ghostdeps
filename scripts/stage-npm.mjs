#!/usr/bin/env node
/**
 * Assembles the publishable single-package layout for the `ghostdeps` npm
 * package into .npm-staging/ (or --out). Run after `pnpm -r run build`.
 *
 * The published package vendors the built @ghostdeps/* workspace packages
 * under node_modules/ (bundledDependencies) instead of bundling to a single
 * file, because the core engine spawns workers via
 * `new Worker(new URL("./adapter-worker.js", import.meta.url))` and loads
 * adapters with dynamic `import(specifier)` - both need real on-disk modules.
 * tree-sitter-rust and web-tree-sitter are vendored too: tree-sitter-rust
 * declares a peer on the native `tree-sitter` package, which would force a
 * node-gyp build on every install (#50, #63); only its .wasm is needed.
 *
 * Usage: node scripts/stage-npm.mjs --version 0.1.0 [--out .npm-staging]
 * See docs/publishing.md.
 */
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const version = arg("version");
const out = path.resolve(root, arg("out") ?? ".npm-staging");

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("error: --version x.y.z is required");
  process.exit(2);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Workspace packages vendored into the published tarball. */
const internal = [
  ["core", "packages/core"],
  ["go", "packages/adapters/go"],
  ["javascript-typescript", "packages/adapters/javascript-typescript"],
  ["python", "packages/adapters/python"],
  ["rust", "packages/adapters/rust"],
];

/** Registry packages vendored to avoid the native tree-sitter peer build. */
const vendoredRegistry = ["tree-sitter-rust", "web-tree-sitter"];

const cliDir = path.join(root, "packages/cli");
if (!existsSync(path.join(cliDir, "dist/main.js"))) {
  console.error("error: packages/cli/dist/main.js missing - run `pnpm -r run build` first");
  process.exit(2);
}
for (const [, rel] of internal) {
  if (!existsSync(path.join(root, rel, "dist/index.js"))) {
    console.error(`error: ${rel}/dist/index.js missing - run \`pnpm -r run build\` first`);
    process.exit(2);
  }
}

// Test artefacts are compiled next to sources; keep them out of the tarball.
const notTest = (src) => !/\.test\.(js|d\.ts)(\.map)?$/.test(src);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The CLI itself is the package root: bin target + runtime.
cpSync(path.join(cliDir, "dist"), path.join(out, "dist"), { recursive: true, filter: notTest });

// Vendored workspace packages keep their name/exports so bare-specifier
// imports (`@ghostdeps/core`, adapter specifiers) resolve exactly as in the
// workspace.
for (const [name, rel] of internal) {
  const srcDir = path.join(root, rel);
  const destDir = path.join(out, "node_modules/@ghostdeps", name);
  mkdirSync(destDir, { recursive: true });
  cpSync(path.join(srcDir, "dist"), path.join(destDir, "dist"), {
    recursive: true,
    filter: notTest,
  });
  const pkg = readJson(path.join(srcDir, "package.json"));
  const kept = {};
  for (const key of ["name", "type", "main", "exports", "engines"]) {
    if (pkg[key] !== undefined) kept[key] = pkg[key];
  }
  kept.version = version;
  writeFileSync(path.join(destDir, "package.json"), `${JSON.stringify(kept, null, 2)}\n`);
}

// Vendored registry packages: copy straight from the installed workspace
// layout so versions match the lockfile exactly. tree-sitter-rust only needs
// its wasm; its binding.gyp/prebuilds/src stay out. web-tree-sitter ships
// its runtime wasm next to the entry files.
for (const name of vendoredRegistry) {
  const srcDir = realpathSync(path.join(root, "packages/adapters/rust/node_modules", name));
  const destDir = path.join(out, "node_modules", name);
  mkdirSync(destDir, { recursive: true });
  if (name === "tree-sitter-rust") {
    for (const f of ["tree-sitter-rust.wasm", "LICENSE"]) {
      copyFileSync(path.join(srcDir, f), path.join(destDir, f));
    }
    // Minimal manifest: no peerDependencies (npm would auto-install the
    // native `tree-sitter` peer and node-gyp-build it on every user
    // machine), no install scripts, no binding.gyp - the wasm is all the
    // adapter loads.
    const pkg = readJson(path.join(srcDir, "package.json"));
    writeFileSync(
      path.join(destDir, "package.json"),
      `${JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          license: pkg.license,
          main: pkg.main ?? "index.js",
        },
        null,
        2,
      )}\n`,
    );
  } else {
    cpSync(srcDir, destDir, {
      recursive: true,
      filter: (src) => !/(^|[/\\])(node_modules|debug)([/\\]|$)/.test(path.relative(srcDir, src)),
    });
    if (!existsSync(path.join(destDir, "web-tree-sitter.wasm"))) {
      console.error("error: web-tree-sitter copy is missing web-tree-sitter.wasm");
      process.exit(2);
    }
  }
}

// Runtime externals stay as normal registry dependencies, pinned to the
// versions the adapters declare.
const jsTs = readJson(path.join(root, "packages/adapters/javascript-typescript/package.json"));
const python = readJson(path.join(root, "packages/adapters/python/package.json"));

const manifest = {
  name: "ghostdeps",
  version,
  description: "Find dependencies your code doesn't really need, in any language.",
  license: "MIT",
  type: "module",
  bin: { ghostdeps: "./dist/main.js" },
  engines: { node: ">=22" },
  files: ["dist"],
  keywords: [
    "dependencies",
    "unused-dependencies",
    "static-analysis",
    "supply-chain-security",
    "code-review",
    "cli",
  ],
  repository: { type: "git", url: "git+https://github.com/rowkavdev/ghostdeps.git" },
  homepage: "https://github.com/rowkavdev/ghostdeps#readme",
  bugs: "https://github.com/rowkavdev/ghostdeps/issues",
  dependencies: {
    "smol-toml": python.dependencies["smol-toml"],
    typescript: jsTs.dependencies.typescript,
    yaml: jsTs.dependencies.yaml,
    // Vendored packages are also listed here (exact versions matching the
    // vendored copies) because npm pack ignores bundledDependencies entries
    // that are extraneous. The bundled copies satisfy these ranges at
    // install time, so npm never fetches them from the registry.
    ...Object.fromEntries(internal.map(([name]) => [`@ghostdeps/${name}`, version])),
    "tree-sitter-rust": readJson(
      path.join(root, "packages/adapters/rust/node_modules/tree-sitter-rust/package.json"),
    ).version,
    "web-tree-sitter": readJson(
      path.join(root, "packages/adapters/rust/node_modules/web-tree-sitter/package.json"),
    ).version,
  },
  bundledDependencies: [...internal.map(([name]) => `@ghostdeps/${name}`), ...vendoredRegistry],
  publishConfig: { access: "public" },
};
writeFileSync(path.join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

copyFileSync(path.join(root, "README.md"), path.join(out, "README.md"));
copyFileSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else {
      files += 1;
      bytes += statSync(p).size;
    }
  }
})(out);
console.log(
  `staged ghostdeps@${version} in ${path.relative(root, out)}: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB unpacked`,
);
