/** Narrow, read-only npm fix preview. No package-manager process, writes or network. */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { EcosystemAdapter } from "../adapter.js";
import type { Dependency, Finding, RepositoryHandle } from "../types/index.js";
import { findingGroup } from "../types/finding-group.js";
import { analyseRepository } from "./analyse.js";
import type { RecommendationInput } from "./analyse.js";
import { scanCompletenessFindings } from "./analyse-directory.js";
import { FsRepositoryHandle } from "./scanner/handle.js";
import { createDefaultPolicy } from "../recommend/policy.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (o: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(o, key) ? o[key] : undefined;
const section = (o: Record<string, unknown>, key: string): Record<string, unknown> | undefined => {
  const value = own(o, key);
  return object(value) ? value : undefined;
};
const canonical = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const safeName = (name: string): boolean =>
  /^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/.test(name) &&
  name !== "__proto__" &&
  name !== "constructor";

export interface FixPreview {
  version: 1;
  status: "blocked" | "statically-checked";
  key?: string;
  reason?: string;
  files?: { path: string; beforeSha256: string; afterSha256: string }[];
  diff?: string;
  verification: {
    static: "passed" | "unavailable";
    lockfile: "passed" | "unavailable";
    sandbox: "not-run";
  };
}
// These notes describe display confidence and line reporting, not lost reference coverage.
const blockingIncomplete = (f: Finding): boolean =>
  findingGroup(f) === "incomplete" &&
  !["unused-confidence-capped", "declaration-line-unavailable"].includes(f.rule ?? "");
const blocked = (reason: string): FixPreview => ({
  version: 1,
  status: "blocked",
  reason,
  verification: { static: "unavailable", lockfile: "unavailable", sandbox: "not-run" },
});
function findingKey(dep: Dependency, finding: Finding, snapshotSha: string): string {
  return sha(
    JSON.stringify([
      1,
      dep.project.ecosystem,
      dep.project.path,
      dep.declaredIn,
      dep.name,
      dep.kind,
      dep.constraint,
      finding.rule,
      finding.evidence,
      snapshotSha,
    ]),
  );
}
function diffFile(path: string, before: string, after: string): string {
  // Bounded whole-file context; the preview does not claim an apply-ready hunk.
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  return (
    [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${a.length} +1,${b.length} @@`,
      ...a.map((line) => `-${line}`),
      ...b.map((line) => `+${line}`),
    ].join("\n") + "\n"
  );
}

/** Bind evidence to every scanned path and byte, not only the two edit targets. */
async function snapshot(
  handle: FsRepositoryHandle,
  paths: readonly string[],
): Promise<string | undefined> {
  if (paths.length > 2000) return undefined;
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for (const path of paths) {
      const content = await handle.readFile(path);
      // FsRepositoryHandle's decoder replaces malformed UTF-8 with U+FFFD.
      // Refuse even a literal replacement character: decoded text cannot prove raw byte identity.
      if (content.includes("\uFFFD")) return undefined;
      bytes += Buffer.byteLength(content);
      if (bytes > 8_000_000) return undefined;
      digest.update(JSON.stringify([path, content]));
    }
  } catch {
    return undefined;
  }
  return digest.digest("hex");
}

/** Every refusal is explicit. Only an exact root npm leaf removal is supported. */
export async function previewNpmRemoval(
  handle: FsRepositoryHandle,
  adapters: readonly EcosystemAdapter[],
  name: string,
): Promise<FixPreview> {
  if (!safeName(name)) return blocked("Package name is not a safe, exact npm name.");
  if (handle.scan.truncated || scanCompletenessFindings(handle.scan).length)
    return blocked("The repository scan is incomplete; no edit is proposed.");
  if (handle.scan.skippedCounts.symlink || handle.scan.skippedCounts["special-file"])
    return blocked("Links or special files leave the edit target or analysis scope uncertain.");
  const listedPaths = await handle.listFiles();
  const paths = new Set(listedPaths);
  // A large or unreadable snapshot cannot be bound without guessing.
  const snapshotSha = await snapshot(handle, listedPaths);
  if (!snapshotSha)
    return blocked("The complete source snapshot cannot be bound within preview limits.");
  if (!paths.has("package.json") || !paths.has("package-lock.json"))
    return blocked("A root package.json and package-lock.json are required.");
  if (
    [
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "lerna.json",
      "pnpm-workspace.yaml",
    ].some((p) => paths.has(p))
  )
    return blocked(
      "Another package manager, shrinkwrap or workspace marker makes npm lockfile ownership ambiguous.",
    );
  if ([...paths].some((p) => p.endsWith("/package.json")))
    return blocked("Nested package manifests or workspaces are not supported in this preview.");
  // An edit target with another hardlink name may cause hidden mutations on apply.
  // Both counts must be exactly one; this also rejects aliases outside the scan.
  try {
    for (const file of ["package.json", "package-lock.json"]) {
      const stat = await lstat(join(handle.scan.root, file));
      if (!stat.isFile() || stat.nlink !== 1)
        return blocked("Hardlink aliases or nonregular edit targets are not supported.");
    }
  } catch {
    return blocked("Edit target became unavailable during preview.");
  }
  let manifestText: string, lockText: string;
  try {
    manifestText = await handle.readFile("package.json");
    lockText = await handle.readFile("package-lock.json");
  } catch {
    return blocked("Manifest or lockfile could not be read from the scanned snapshot.");
  }
  const unsafeDisplay = /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
  const rawControl = (text: string): boolean =>
    [...text].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 31 && code !== 9 && code !== 10 && code !== 13;
    });
  if (unsafeDisplay.test(manifestText + lockText) || rawControl(manifestText + lockText))
    return blocked("Control or bidirectional formatting characters cannot be safely displayed.");
  if (manifestText.length > 512_000 || lockText.length > 2_000_000)
    return blocked("Manifest or lockfile exceeds the preview byte ceiling.");
  let manifest: unknown, lock: unknown;
  try {
    manifest = JSON.parse(manifestText);
    lock = JSON.parse(lockText);
  } catch {
    return blocked("Manifest or lockfile is not valid JSON.");
  }
  if (
    !object(manifest) ||
    !object(lock) ||
    manifestText !== canonical(manifest) ||
    lockText !== canonical(lock)
  )
    return blocked(
      "Only canonical two-space JSON is supported; formatting would otherwise change unrelated lines.",
    );
  if (
    typeof manifest.packageManager !== "string" ||
    !/^npm@\d+\.\d+\.\d+$/.test(manifest.packageManager)
  )
    return blocked("An explicit npm@major.minor.patch packageManager pin is required.");
  if (
    own(manifest, "workspaces") !== undefined ||
    own(manifest, "overrides") !== undefined ||
    own(manifest, "bundleDependencies") !== undefined ||
    own(manifest, "bundledDependencies") !== undefined
  )
    return blocked("Workspace, override or bundled dependency semantics are not supported.");
  const version = lock.lockfileVersion;
  const npmMajor = Number(/^npm@(\d+)/.exec(manifest.packageManager)?.[1]);
  if (
    (version === 2 && (npmMajor < 7 || npmMajor > 8)) ||
    (version === 3 && (npmMajor < 9 || npmMajor > 10))
  )
    return blocked("The pinned npm major and lockfile version are not a supported pair.");
  if (
    Object.keys(lock).some(
      (key) =>
        !["name", "version", "lockfileVersion", "requires", "packages", "dependencies"].includes(
          key,
        ),
    )
  )
    return blocked("Unsupported lockfile fields prevent a bounded exact edit.");
  if (version !== 2 && version !== 3)
    return blocked("Only npm lockfileVersion 2 or 3 is supported; version 1 is not.");
  if (!object(lock.packages) || !object(own(lock.packages, "")))
    return blocked("The lockfile has no unambiguous root package entry.");
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  if (
    !Object.keys(manifest).every((key) =>
      ["name", "version", "private", "packageManager", "dependencies", "devDependencies"].includes(
        key,
      ),
    )
  )
    return blocked(
      "Unsupported manifest fields may change install or published-package semantics.",
    );
  const found = sections.filter(
    (s) => own(section(manifest as Record<string, unknown>, s) ?? {}, name) !== undefined,
  );
  if (found.length !== 1 || !["dependencies", "devDependencies"].includes(found[0]!))
    return blocked("The package must have exactly one runtime or dev declaration.");
  const field = found[0]!;
  const constraint = own(section(manifest, field)!, name);
  if (
    typeof constraint !== "string" ||
    !constraint ||
    /^(?:npm:|file:|link:|workspace:|git|https?:)/.test(constraint)
  )
    return blocked("Non-registry, alias or malformed specifiers cannot be removed automatically.");
  const root = lock.packages[""] as Record<string, unknown>;
  if (
    lock.name !== manifest.name ||
    lock.version !== manifest.version ||
    root.name !== manifest.name ||
    root.version !== manifest.version ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  )
    return blocked("Manifest and lockfile root identity disagree.");
  if (
    Object.keys(root).some(
      (key) => !["name", "version", "dependencies", "devDependencies"].includes(key),
    )
  )
    return blocked("Unsupported lockfile root metadata could affect package semantics.");
  if (own(section(root, field) ?? {}, name) !== constraint)
    return blocked("Lockfile root declaration does not exactly match the manifest.");
  for (const s of sections) {
    if (JSON.stringify(section(root, s) ?? {}) !== JSON.stringify(section(manifest, s) ?? {}))
      return blocked("Other root declarations disagree with the lockfile.");
  }
  for (const s of sections) {
    if (own(manifest, s) !== undefined && !section(manifest, s))
      return blocked("Malformed manifest declaration section.");
    if (own(root, s) !== undefined && !section(root, s))
      return blocked("Malformed lockfile root declaration section.");
  }
  const nodeKey = `node_modules/${name}`;
  if (
    Object.keys(lock.packages).some(
      (key) => key !== "" && key !== nodeKey && !/^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(key),
    )
  )
    return blocked("Nested or nonstandard lockfile paths require a resolver.");
  const node = own(lock.packages, nodeKey);
  if (
    !object(node) ||
    typeof node.version !== "string" ||
    node.link === true ||
    node.bundled === true ||
    node.inBundle === true
  )
    return blocked("The direct package has no ordinary resolved leaf lockfile entry.");
  if (sections.some((s) => own(node, s) !== undefined))
    return blocked(
      "This dependency has transitive edges; deterministic tree regeneration is not supported.",
    );
  if (
    Object.keys(node).some(
      (key) =>
        ![
          "version",
          "resolved",
          "integrity",
          "dev",
          "optional",
          "engines",
          "funding",
          "license",
          "deprecated",
          "hasInstallScript",
        ].includes(key),
    ) ||
    node.hasInstallScript === true ||
    node.optional === true
  )
    return blocked("Unsupported target lockfile metadata or lifecycle script.");
  if (Object.keys(lock.packages).some((p) => p !== nodeKey && p.startsWith(`${nodeKey}/`)))
    return blocked("Nested packages require a resolver and are not supported.");
  for (const [p, entry] of Object.entries(lock.packages)) {
    if (p === "" || p === nodeKey) continue;
    if (
      !object(entry) ||
      typeof entry.version !== "string" ||
      sections.some((s) => own(entry, s) !== undefined && !section(entry, s))
    )
      return blocked("Malformed lockfile package entry.");
    if (sections.some((s) => own(section(entry, s) ?? {}, name) !== undefined))
      return blocked("Another locked package references this dependency.");
  }
  if (version === 2) {
    const legacy = section(lock, "dependencies");
    const legacyNode = legacy && own(legacy, name);
    if (
      !legacy ||
      !object(legacyNode) ||
      legacyNode.version !== node.version ||
      own(legacyNode, "dependencies") !== undefined ||
      own(legacyNode, "requires") !== undefined ||
      Object.keys(legacyNode).some(
        (key) => !["version", "resolved", "integrity", "dev", "optional"].includes(key),
      ) ||
      ["resolved", "integrity", "dev", "optional"].some(
        (field) => JSON.stringify(own(legacyNode, field)) !== JSON.stringify(own(node, field)),
      ) ||
      Object.keys(legacy).some((key) => {
        const packageEntry = own(lock.packages as Record<string, unknown>, `node_modules/${key}`);
        const legacyEntry = legacy[key];
        return (
          !object(packageEntry) ||
          !object(legacyEntry) ||
          legacyEntry.version !== packageEntry.version ||
          ["resolved", "integrity", "dev", "optional"].some(
            (field) =>
              JSON.stringify(own(legacyEntry, field)) !== JSON.stringify(own(packageEntry, field)),
          ) ||
          ["requires", "dependencies"].some(
            (field) => own(legacyEntry, field) !== undefined && !section(legacyEntry, field),
          )
        );
      }) ||
      Object.entries(legacy).some(
        ([other, entry]) =>
          other !== name &&
          object(entry) &&
          (own(section(entry, "requires") ?? {}, name) !== undefined ||
            own(section(entry, "dependencies") ?? {}, name) !== undefined),
      )
    )
      return blocked("The v2 legacy dependencies section cannot be updated consistently.");
  } else if (own(lock, "dependencies") !== undefined) {
    return blocked("Unexpected legacy dependencies in a v3 lockfile.");
  }
  if ([...paths].some((p) => p === ".npmrc" || p.endsWith("/.npmrc")))
    return blocked("npm configuration may change resolution or registry settings.");

  let policyFacts: RecommendationInput | undefined;
  const baseline = await analyseRepository(handle, {
    adapters,
    network: { mode: "offline" },
    scanCompleteness: scanCompletenessFindings(handle.scan),
    recommend: (input) => {
      policyFacts = input;
      return createDefaultPolicy()(input);
    },
  });
  const facts = policyFacts as RecommendationInput | undefined;
  if (
    !facts?.referenceAnalysedEcosystems.has("javascript-typescript") ||
    !facts.usageAnalysedEcosystems.has("javascript-typescript")
  )
    return blocked("Complete source, script and config reference analysis is unavailable.");
  if (
    baseline.findings.some(blockingIncomplete) ||
    baseline.surface.find((s) => s.ecosystem === "javascript-typescript")?.graphs !== "complete"
  )
    return blocked("The analysis or dependency graph is incomplete.");
  const matches = baseline.dependencies.filter(
    (d) =>
      d.project.ecosystem === "javascript-typescript" &&
      d.project.path === "." &&
      d.declaredIn === "package.json" &&
      d.name === name &&
      d.constraint === constraint &&
      d.kind === (field === "dependencies" ? "runtime" : "dev") &&
      (d.specifier === undefined || (d.specifier.type === "registry" && !d.specifier.detail)),
  );
  if (matches.length !== 1)
    return blocked("The dependency declaration is not unique and verified.");
  const dep = matches[0]!;
  const findings = baseline.findings.filter(
    (f) =>
      f.kind === "unused" &&
      f.rule === "unused" &&
      f.dependency === name &&
      f.evidence.some((e) => e.kind === "no-reference-found") &&
      f.affectedFiles.includes("package.json"),
  );
  if (findings.length !== 1 || facts.usages.some((u) => u.dependency === name && !u.removedInPr))
    return blocked("Independent unused and no-reference evidence is unavailable.");
  const key = findingKey(dep, findings[0]!, snapshotSha);
  const editedManifest = structuredClone(manifest);
  const editedLock = structuredClone(lock);
  delete section(editedManifest, field)![name];
  delete section(
    (editedLock.packages as Record<string, unknown>)[""] as Record<string, unknown>,
    field,
  )![name];
  delete (editedLock.packages as Record<string, unknown>)[nodeKey];
  if (version === 2) delete (editedLock.dependencies as Record<string, unknown>)[name];
  const afterManifest = canonical(editedManifest);
  const afterLock = canonical(editedLock);
  const changes = new Map([
    ["package.json", afterManifest],
    ["package-lock.json", afterLock],
  ]);
  const overlay: RepositoryHandle = {
    listFiles: () => handle.listFiles(),
    exists: (p) => handle.exists(p),
    readFile: async (p) => changes.get(p) ?? handle.readFile(p),
    readFileHead: async (p, max) =>
      changes.has(p) ? changes.get(p)!.slice(0, max) : handle.readFileHead(p, max),
  };
  let overlayFacts: RecommendationInput | undefined;
  const after = await analyseRepository(overlay, {
    adapters,
    network: { mode: "offline" },
    recommend: (input) => {
      overlayFacts = input;
      return createDefaultPolicy()(input);
    },
  });
  const checked = overlayFacts as RecommendationInput | undefined;
  if (
    !checked?.referenceAnalysedEcosystems.has("javascript-typescript") ||
    after.dependencies.some(
      (d) => d.project.ecosystem === "javascript-typescript" && d.name === name,
    ) ||
    after.findings.some(blockingIncomplete) ||
    (after.surface.find((s) => s.ecosystem === "javascript-typescript")?.graphs !== "complete" &&
      !(
        checked.graphs.length === 1 &&
        checked.graphs[0]?.incomplete === false &&
        checked.graphs[0].nodes.length === 0 &&
        after.dependencies.length === 0
      )) ||
    after.dependencies.length !== baseline.dependencies.length - 1 ||
    after.usages.length !== baseline.usages.length
  )
    return blocked("Static overlay analysis did not verify the scoped declaration removal.");
  // Rescan to catch added/deleted paths; compare every source byte, not only edit targets.
  // The second scan also refuses newly linked, skipped or unreadable source entries.
  let current: FsRepositoryHandle;
  try {
    current = await FsRepositoryHandle.open(handle.scan.root, { limits: handle.scan.limits });
  } catch {
    return blocked("Repository changed or became unreadable during preview.");
  }
  try {
    for (const file of ["package.json", "package-lock.json"]) {
      const stat = await lstat(join(current.scan.root, file));
      if (!stat.isFile() || stat.nlink !== 1)
        return blocked("Hardlink aliases or nonregular edit targets are not supported.");
    }
  } catch {
    return blocked("Edit target became unavailable during preview.");
  }
  if (
    current.scan.truncated ||
    scanCompletenessFindings(current.scan).length ||
    current.scan.skippedCounts.symlink ||
    current.scan.skippedCounts["special-file"] ||
    JSON.stringify(await current.listFiles()) !== JSON.stringify(listedPaths) ||
    (await snapshot(current, listedPaths)) !== snapshotSha
  )
    return blocked("Source snapshot changed during preview; rerun on the current snapshot.");
  const diff =
    diffFile("package.json", manifestText, afterManifest) +
    diffFile("package-lock.json", lockText, afterLock);
  if (diff.length > 100_000) return blocked("Preview diff exceeds the display ceiling.");
  return {
    version: 1,
    status: "statically-checked",
    key,
    files: [
      { path: "package.json", beforeSha256: sha(manifestText), afterSha256: sha(afterManifest) },
      { path: "package-lock.json", beforeSha256: sha(lockText), afterSha256: sha(afterLock) },
    ],
    diff,
    verification: { static: "passed", lockfile: "passed", sandbox: "not-run" },
  };
}
