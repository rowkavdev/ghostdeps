/**
 * Import name -> distribution name mapping (issue #46). Python imports
 * modules, manifests declare distributions, and the two names often differ
 * (`import yaml` comes from PyYAML). Resolution is static and never
 * installs anything:
 *
 * 1. standard library -> "stdlib" (not a dependency);
 * 2. first-party packages of the repository itself -> "first-party";
 * 3. `top_level.txt` metadata committed in the repository (*.dist-info /
 *    *.egg-info), which names the modules a distribution provides;
 * 4. the maintained KNOWN_IMPORT_NAMES table below;
 * 5. the default rule: a declared dependency whose PEP 503 name equals the
 *    normalised import name.
 *
 * Anything else is "unresolved" and reported as such, never guessed.
 *
 * Known limit: a declared stdlib backport (`typing`, `dataclasses`, `enum34`
 * for `enum`) is shadowed by rule 1, so its imports resolve to "stdlib".
 * A later unused check must not treat "declared but shadowed by stdlib" as
 * high-confidence unused.
 */
import { hasExcludedSegment, type RepositoryHandle } from "@ghostdeps/core";
import { normaliseName } from "./pep508.js";
import { STDLIB_MODULES } from "./stdlib.js";

/**
 * Known import names whose distribution name differs. Keys are top-level
 * import names (case-sensitive, as imported); values are PEP 503 names.
 * Several distributions can provide one module (`cv2`, `psycopg2`), so values
 * are lists; resolution credits every one the project declares.
 *
 * Keys may be dotted for namespace packages (`google.protobuf`): the
 * longest matching dotted prefix of the import wins.
 */
export const KNOWN_IMPORT_NAMES: Readonly<Record<string, readonly string[]>> = {
  attr: ["attrs"],
  bs4: ["beautifulsoup4"],
  cv2: ["opencv-python", "opencv-python-headless", "opencv-contrib-python"],
  Crypto: ["pycryptodome", "pycrypto"],
  Cryptodome: ["pycryptodomex"],
  dateutil: ["python-dateutil"],
  docx: ["python-docx"],
  dotenv: ["python-dotenv"],
  fitz: ["pymupdf"],
  git: ["gitpython"],
  "google.auth": ["google-auth"],
  "google.cloud.bigquery": ["google-cloud-bigquery"],
  "google.cloud.pubsub": ["google-cloud-pubsub"],
  "google.cloud.pubsub_v1": ["google-cloud-pubsub"],
  "google.cloud.storage": ["google-cloud-storage"],
  "google.oauth2": ["google-auth"],
  "google.protobuf": ["protobuf"],
  googleapiclient: ["google-api-python-client"],
  jose: ["python-jose"],
  jwt: ["pyjwt"],
  magic: ["python-magic"],
  MySQLdb: ["mysqlclient"],
  multipart: ["python-multipart"],
  OpenSSL: ["pyopenssl"],
  PIL: ["pillow"],
  pkg_resources: ["setuptools"],
  pptx: ["python-pptx"],
  psycopg2: ["psycopg2", "psycopg2-binary"],
  serial: ["pyserial"],
  six: ["six"],
  skimage: ["scikit-image"],
  sklearn: ["scikit-learn"],
  slugify: ["python-slugify"],
  usb: ["pyusb"],
  win32api: ["pywin32"],
  win32con: ["pywin32"],
  yaml: ["pyyaml"],
  zmq: ["pyzmq"],
};

/**
 * Namespace package roots shared by unrelated distributions. An import under
 * one of these resolves only through a dotted table key; the bare root is
 * never credited through metadata or the name rule (`import google` alone
 * says nothing about protobuf vs google-cloud-storage).
 */
export const NAMESPACE_ROOTS: ReadonlySet<string> = new Set([
  "azure",
  "backports",
  "google",
  "jaraco",
  "sphinxcontrib",
  "zope",
]);

export type ImportResolution =
  | { kind: "stdlib"; module: string }
  | { kind: "first-party"; module: string }
  | {
      kind: "dependency";
      module: string;
      /**
       * Every declared distribution the import is credited to, sorted. More
       * than one means the project declares alternatives that provide the
       * same module (opencv-python and opencv-python-headless); each is
       * credited, none is picked silently.
       */
      distributions: string[];
      via: "metadata" | "table" | "name";
    }
  | { kind: "unresolved"; module: string; candidates: string[] };

export interface ImportResolverInput {
  /** PEP 503 names of the project's declared dependencies. */
  declared: Iterable<string>;
  /** Top-level module names the repository itself provides. */
  firstParty?: Iterable<string>;
  /** Distribution (PEP 503) -> top-level modules, from committed top_level.txt files. */
  topLevel?: ReadonlyMap<string, readonly string[]>;
}

/** Top-level module of a dotted import: "google.protobuf.message" -> "google". */
export function topLevelModule(importPath: string): string {
  const dot = importPath.indexOf(".");
  return dot === -1 ? importPath : importPath.slice(0, dot);
}

export class ImportResolver {
  private readonly declared: ReadonlySet<string>;
  private readonly firstParty: ReadonlySet<string>;
  /** Module -> distributions that provide it, from metadata. */
  private readonly provides = new Map<string, string[]>();

  constructor(input: ImportResolverInput) {
    this.declared = new Set([...input.declared].map(normaliseName));
    this.firstParty = new Set(input.firstParty ?? []);
    for (const [dist, modules] of input.topLevel ?? []) {
      for (const module of modules) {
        const list = this.provides.get(module) ?? [];
        list.push(normaliseName(dist));
        this.provides.set(module, list);
      }
    }
  }

  resolve(importPath: string): ImportResolution {
    const module = topLevelModule(importPath);
    if (STDLIB_MODULES.has(module)) return { kind: "stdlib", module };
    if (this.firstParty.has(module)) return { kind: "first-party", module };
    const declaredOnly = (dists: readonly string[]) =>
      [...new Set(dists.filter((d) => this.declared.has(d)))].sort();

    // Longest dotted table key first: google.cloud.storage before google.
    const segments = importPath.split(".");
    let known: readonly string[] = [];
    let knownKey = module;
    for (let k = segments.length; k >= 1; k--) {
      const key = segments.slice(0, k).join(".");
      const hit = KNOWN_IMPORT_NAMES[key];
      if (hit !== undefined) {
        known = hit;
        knownKey = key;
        break;
      }
    }
    const namespaced = NAMESPACE_ROOTS.has(module);
    if (!namespaced) {
      const fromMetadata = declaredOnly(this.provides.get(module) ?? []);
      if (fromMetadata.length > 0) {
        return { kind: "dependency", module, distributions: fromMetadata, via: "metadata" };
      }
    }
    const fromTable = declaredOnly(known);
    if (fromTable.length > 0) {
      return { kind: "dependency", module: knownKey, distributions: fromTable, via: "table" };
    }
    if (!namespaced) {
      const byName = normaliseName(module);
      if (this.declared.has(byName)) {
        return { kind: "dependency", module, distributions: [byName], via: "name" };
      }
    }
    // Candidates are reported for the reader; none is attributed.
    const candidates = [...new Set([...(this.provides.get(module) ?? []), ...known])];
    return { kind: "unresolved", module: namespaced ? knownKey : module, candidates };
  }

  /** Every import name that would resolve to `distribution` (for usage search). */
  importNamesFor(distribution: string): string[] {
    const dist = normaliseName(distribution);
    const names = new Set<string>();
    for (const [module, dists] of this.provides) if (dists.includes(dist)) names.add(module);
    for (const [module, dists] of Object.entries(KNOWN_IMPORT_NAMES)) {
      if (dists.includes(dist)) names.add(module);
    }
    // Default rule: the import name normalises to the distribution name.
    names.add(dist.replace(/-/g, "_"));
    return [...names].sort();
  }
}

/** Parse a top_level.txt body: one module per line. */
export function parseTopLevel(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(line));
}

/**
 * Distribution name from a metadata directory path:
 * "vendor/PyYAML-6.0.1.dist-info/top_level.txt" -> "pyyaml".
 */
export function distributionFromMetadataPath(path: string): string | undefined {
  const match =
    /(?:^|\/)([A-Za-z0-9][A-Za-z0-9._]*?)(?:-[0-9][^/]*)?\.(?:dist-info|egg-info)\/top_level\.txt$/.exec(
      path,
    );
  return match?.[1] === undefined ? undefined : normaliseName(match[1]);
}

/** top_level.txt files are tiny; anything larger is not metadata. */
const MAX_TOP_LEVEL_BYTES = 64 * 1024;

/**
 * Collect committed top_level.txt metadata under a project root
 * (distribution -> modules). Excluded directories (virtualenvs,
 * site-packages, vendor/ ...) are skipped, as in detection; unreadable or
 * oversized files are skipped. Pass `files` (listed once) when resolving
 * many projects, so the repository is not re-listed per project.
 */
export async function readTopLevelMetadata(
  repository: RepositoryHandle,
  projectPath: string,
  files?: readonly string[],
): Promise<Map<string, string[]>> {
  const prefix = projectPath === "." ? "" : `${projectPath}/`;
  const out = new Map<string, string[]>();
  for (const file of files ?? (await repository.listFiles())) {
    if (!file.startsWith(prefix) || hasExcludedSegment(file)) continue;
    const dist = distributionFromMetadataPath(file);
    if (dist === undefined) continue;
    let text: string | undefined;
    try {
      // Enforce the cap at read time when the handle supports it.
      text =
        repository.readFileHead !== undefined
          ? await repository.readFileHead(file, MAX_TOP_LEVEL_BYTES + 1)
          : await repository.readFile(file);
    } catch {
      continue;
    }
    if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_TOP_LEVEL_BYTES) continue;
    out.set(dist, [...new Set([...(out.get(dist) ?? []), ...parseTopLevel(text)])]);
  }
  return out;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Top-level modules the project itself provides: packages (a directory
 * with __init__.py) and single-file modules at the project root or under
 * src/. Implicit namespace packages without __init__.py are not guessed.
 */
export function firstPartyModules(projectPath: string, files: readonly string[]): string[] {
  const prefix = projectPath === "." ? "" : `${projectPath}/`;
  const modules = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    let rel = file.slice(prefix.length);
    if (rel.startsWith("src/")) rel = rel.slice(4);
    const parts = rel.split("/");
    if (parts.length === 2 && parts[1] === "__init__.py" && IDENTIFIER.test(parts[0]!)) {
      modules.add(parts[0]!);
    } else if (parts.length === 1 && parts[0]!.endsWith(".py")) {
      const name = parts[0]!.slice(0, -3);
      if (IDENTIFIER.test(name) && name !== "setup" && name !== "conftest") modules.add(name);
    }
  }
  return [...modules].sort();
}
