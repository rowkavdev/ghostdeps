/**
 * Package-manager detection for JS/TS projects (issue #25). Detection is
 * evidence-driven per project root: lockfiles plus the package.json
 * "packageManager" pin. Conflicting signals are reported as evidence with
 * reduced confidence - GhostDeps never guesses a package manager.
 */
import type { Evidence, PackageManager, RepositoryHandle } from "@ghostdeps/core";
import { displayRoot, joinPath } from "./paths.js";

export interface PackageManagerDetection {
  managers: PackageManager[];
  evidence: Evidence[];
  /** True when signals disagree (multiple lockfiles, or pin vs lockfile). */
  conflict: boolean;
}

interface LockfileSignal {
  file: string;
  manager: string;
}

/** Checked in order; the first hit per manager becomes its lockfile evidence. */
const LOCKFILE_SIGNALS: readonly LockfileSignal[] = [
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
];

/** Read the corepack "packageManager" pin, e.g. "pnpm@12.6.0" -> "pnpm". */
function readPackageManagerPin(manifestText: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(manifestText);
    if (typeof manifest !== "object" || manifest === null) return undefined;
    const pin = (manifest as Record<string, unknown>).packageManager;
    if (typeof pin !== "string") return undefined;
    const name = pin.split("@")[0];
    return name === "" ? undefined : name;
  } catch {
    return undefined; // malformed manifests are detection's business (#24), not a crash here
  }
}

export async function detectPackageManagers(
  repository: RepositoryHandle,
  root: string,
  knownFiles?: ReadonlySet<string>,
): Promise<PackageManagerDetection> {
  const at = (name: string): string => joinPath(root, name);
  const evidence: Evidence[] = [];
  const lockfileByManager = new Map<string, string>();

  for (const signal of LOCKFILE_SIGNALS) {
    if (!(await repository.exists(at(signal.file)))) continue;
    if (!lockfileByManager.has(signal.manager)) {
      lockfileByManager.set(signal.manager, signal.file);
    }
    evidence.push({
      kind: "lockfile-found",
      statement: `found ${at(signal.file)} (${signal.manager})`,
      file: at(signal.file),
    });
  }

  // Yarn classic vs berry. The lockfile itself is the strongest signal:
  // berry lockfiles open with a "__metadata:" block, classic v1 lockfiles
  // with a "# yarn lockfile v1" header. Marker files (.yarnrc.yml, .yarn/)
  // are only a fallback - classic setups can have .yarn/ too.
  if (lockfileByManager.has("yarn")) {
    let head: string;
    try {
      head = (await repository.readFile(at("yarn.lock"))).slice(0, 512);
    } catch {
      head = "";
    }
    let berry: boolean;
    let basis: string;
    if (head.startsWith("__metadata:")) {
      berry = true;
      basis = "lockfile __metadata block";
    } else if (head.includes("yarn lockfile v1")) {
      berry = false;
      basis = "lockfile v1 header";
    } else {
      const files = knownFiles ?? new Set(await repository.listFiles());
      berry =
        files.has(at(".yarnrc.yml")) ||
        [...files].some((file) => file.startsWith(`${at(".yarn")}/`));
      basis = ".yarnrc.yml/.yarn markers";
    }
    evidence.push({
      kind: "package-manager-variant",
      statement: `yarn ${berry ? "berry" : "classic"} at ${displayRoot(root)} (${basis})`,
    });
  }

  let pin: string | undefined;
  try {
    pin = readPackageManagerPin(await repository.readFile(at("package.json")));
  } catch {
    pin = undefined; // no readable manifest at this root
  }
  if (pin !== undefined) {
    evidence.push({
      kind: "package-manager-pin",
      statement: `package.json pins packageManager to ${pin}`,
      file: at("package.json"),
    });
  }

  const lockfileManagers = [...lockfileByManager.keys()];
  const pinDisagrees =
    pin !== undefined && lockfileManagers.length > 0 && !lockfileByManager.has(pin);
  const conflict = lockfileManagers.length > 1 || pinDisagrees;

  if (lockfileManagers.length > 1) {
    evidence.push({
      kind: "lockfile-conflict",
      statement: `conflicting lockfiles at ${root}: ${[...lockfileByManager.values()].join(" and ")}; reporting every candidate, not guessing`,
    });
  }
  if (pinDisagrees) {
    evidence.push({
      kind: "lockfile-conflict",
      statement: `packageManager pin "${pin}" disagrees with lockfile evidence (${[...lockfileByManager.values()].join(", ")}) at ${root}`,
    });
  }

  if (lockfileManagers.length === 0 && pin !== undefined) {
    evidence.push({
      kind: "package-manager-no-lockfile",
      statement: `no lockfile at ${root}; only the packageManager pin "${pin}" is available`,
    });
  }

  // Order: the pinned manager first when it also has a lockfile, then the rest
  // in signal order. With no lockfile at all, the pin alone is reported.
  const ordered: PackageManager[] = [];
  if (pin !== undefined && lockfileByManager.has(pin)) {
    const pinned: PackageManager = { name: pin };
    const pinnedLockfile = lockfileByManager.get(pin);
    if (pinnedLockfile !== undefined) pinned.lockfile = pinnedLockfile;
    ordered.push(pinned);
  }
  for (const [manager, lockfile] of lockfileByManager) {
    if (manager !== pin) ordered.push({ name: manager, lockfile });
  }
  if (ordered.length === 0 && pin !== undefined) {
    ordered.push({ name: pin });
  }

  return { managers: ordered, evidence, conflict };
}
