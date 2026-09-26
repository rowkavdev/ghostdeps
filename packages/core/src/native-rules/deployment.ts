/**
 * One fail-closed, data-only deployment pillar (#438). Only an explicit,
 * exhaustive root ghostdeps.targets.json inventory establishes targets.
 * This does not seal native eligibility or emit a finding.
 */
import { createHash } from "node:crypto";
import type { RepositoryHandle } from "../types/index.js";
import type { NativeRule } from "./index.js";
import type { NativeDeploymentTarget, NativeSourceProof } from "./producer.js";

export const NATIVE_TARGETS_FILE = "ghostdeps.targets.json";
const MAX_TARGETS = 64;
const MAX_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const FLOOR = /^(?:>=)?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const RULE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface NativeDeploymentBlock {
  readonly binding: "caller-asserted";
  readonly reason:
    | "snapshot-unavailable"
    | "declaration-unavailable"
    | "incomplete-inventory"
    | "schema-invalid"
    | "ambiguous-range"
    | "unsupported-target"
    | "below-floor";
  readonly detail: string;
  readonly source?: NativeSourceProof;
}

/** A pillar result only. Its snapshot binding is explicitly NOT verified. */
export type NativeDeploymentGateResult =
  | {
      readonly status: "blocked";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted";
      readonly targets: readonly NativeDeploymentTarget[];
      readonly blocking: readonly [NativeDeploymentBlock, ...NativeDeploymentBlock[]];
    }
  | {
      readonly status: "pass";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted";
      readonly targets: readonly [NativeDeploymentTarget, ...NativeDeploymentTarget[]];
      readonly blocking: readonly [];
    };

const version = (value: string, pattern: RegExp): readonly number[] | null => {
  const matched = pattern.exec(value);
  if (!matched) return null;
  const numbers = matched
    .slice(1)
    .filter((part) => part !== undefined)
    .map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
};
const meets = (actual: readonly number[], required: readonly number[]): boolean => {
  for (let i = 0; i < 3; i++) {
    if ((actual[i] ?? 0) !== (required[i] ?? 0)) return (actual[i] ?? 0) > (required[i] ?? 0);
  }
  return true;
};
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");

/** Locate bounded target object bytes, respecting braces inside JSON strings. */
function targetSlices(raw: string): { text: string; start: number }[] | null {
  const key = /"targets"\s*:\s*\[/.exec(raw);
  if (!key || key.index === undefined) return null;
  const start = key.index + key[0].length;
  const slices: { text: string; start: number }[] = [];
  let objectStart = -1,
    depth = 0,
    inString = false,
    escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth++ === 0) objectStart = i;
      continue;
    }
    if (ch === "}") {
      if (--depth < 0) return null;
      if (depth === 0 && objectStart >= 0) {
        slices.push({ text: raw.slice(objectStart, i + 1), start: objectStart });
        objectStart = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 0) return slices;
  }
  return null;
}

/** Reject duplicate object keys without treating key-like strings as keys. */
function hasDuplicateKeys(raw: string): boolean {
  const stack: { kind: "object" | "array"; keys: Set<string>; expectingKey: boolean }[] = [];
  for (let i = 0; i < raw.length;) {
    const ch = raw[i]!;
    if (ch === '"') {
      const start = i++;
      let escaped = false;
      for (; i < raw.length; i++) {
        if (escaped) escaped = false;
        else if (raw[i] === "\\") escaped = true;
        else if (raw[i] === '"') {
          i++;
          break;
        }
      }
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.expectingKey) {
        let key: unknown;
        try {
          key = JSON.parse(raw.slice(start, i));
        } catch {
          return true;
        }
        if (typeof key !== "string" || frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.expectingKey = false;
      }
      continue;
    }
    if (ch === "{") stack.push({ kind: "object", keys: new Set(), expectingKey: true });
    else if (ch === "[") stack.push({ kind: "array", keys: new Set(), expectingKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const frame = stack.at(-1);
      if (frame?.kind === "object") frame.expectingKey = true;
    }
    i++;
  }
  return false;
}

/** Only read the exact repository file; ignore CI, engines, and the scanner's Node. */
export async function collectNativeDeploymentEvidence(
  repository: RepositoryHandle,
  rule: NativeRule,
  snapshotSha256: string,
): Promise<NativeDeploymentGateResult> {
  const targets: NativeDeploymentTarget[] = [];
  const blocking: NativeDeploymentBlock[] = [];
  const block = (
    reason: NativeDeploymentBlock["reason"],
    detail: string,
    source?: NativeSourceProof,
  ) => {
    blocking.push({ binding: "caller-asserted", reason, detail, ...(source ? { source } : {}) });
  };
  const result = (): NativeDeploymentGateResult =>
    blocking.length > 0
      ? {
          status: "blocked",
          snapshotSha256,
          binding: "caller-asserted",
          targets,
          blocking: blocking as [NativeDeploymentBlock, ...NativeDeploymentBlock[]],
        }
      : {
          status: "pass",
          snapshotSha256,
          binding: "caller-asserted",
          targets: targets as [NativeDeploymentTarget, ...NativeDeploymentTarget[]],
          blocking: [],
        };

  if (!SHA256.test(snapshotSha256)) {
    block("snapshot-unavailable", "No valid snapshot digest was supplied.");
    return result();
  }
  let raw: string;
  try {
    if (!(await repository.exists(NATIVE_TARGETS_FILE))) {
      block("declaration-unavailable", "Root ghostdeps.targets.json is absent.");
      return result();
    }
    raw = await repository.readFile(NATIVE_TARGETS_FILE);
  } catch {
    block("declaration-unavailable", "Root ghostdeps.targets.json cannot be read.");
    return result();
  }
  if (Buffer.byteLength(raw) > MAX_BYTES) {
    block("schema-invalid", "Target declaration exceeds the 64 KiB parse ceiling.");
    return result();
  }
  // Reject duplicate JSON keys before JSON.parse can silently keep the last
  // value. String contents are ignored by the key scanner.
  if (hasDuplicateKeys(raw)) {
    block("schema-invalid", "Target declaration has duplicate JSON keys.");
    return result();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    block("schema-invalid", "Target declaration is not valid JSON.");
    return result();
  }
  if (
    !plain(parsed) ||
    !keys(parsed, ["schemaVersion", "complete", "targets"]) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.targets) ||
    parsed.targets.length < 1 ||
    parsed.targets.length > MAX_TARGETS
  ) {
    block("schema-invalid", "Expected schemaVersion 1 and 1-64 explicit targets.");
    return result();
  }
  if (parsed.complete !== true) {
    block("incomplete-inventory", "The target inventory does not attest complete:true.");
    return result();
  }
  const slices = targetSlices(raw);
  if (!slices || slices.length !== parsed.targets.length) {
    block("schema-invalid", "Target source spans could not be located unambiguously.");
    return result();
  }
  const seen = new Set<string>();
  for (const [index, entry] of parsed.targets.entries()) {
    if (
      !plain(entry) ||
      !keys(entry, ["id", "runtime", "minVersion"]) ||
      typeof entry.id !== "string" ||
      !ID.test(entry.id) ||
      typeof entry.runtime !== "string" ||
      !ID.test(entry.runtime) ||
      typeof entry.minVersion !== "string"
    ) {
      block("schema-invalid", "A target entry is malformed.");
      continue;
    }
    if (seen.has(entry.id)) {
      block("schema-invalid", `Duplicate target id ${entry.id}.`);
      continue;
    }
    seen.add(entry.id);
    const slice = slices[index]!;
    let sliceValue: unknown;
    try {
      sliceValue = JSON.parse(slice.text);
    } catch {
      block("schema-invalid", `Target ${entry.id} has an unreadable source span.`);
      continue;
    }
    if (!plain(sliceValue) || JSON.stringify(sliceValue) !== JSON.stringify(entry)) {
      block(
        "schema-invalid",
        `Target ${entry.id} source span does not match its parsed declaration.`,
      );
      continue;
    }
    const line = raw.slice(0, slice.start).split("\n").length;
    const source: NativeSourceProof = {
      snapshotSha256,
      file: NATIVE_TARGETS_FILE,
      line,
      span: { sha256: createHash("sha256").update(slice.text).digest("hex") },
    };
    const entryText = slice.text;
    const parsedFloor = version(entry.minVersion, FLOOR);
    const target: NativeDeploymentTarget = {
      binding: "caller-asserted",
      target: entry.id,
      runtime: entry.runtime,
      minimumVersion: parsedFloor
        ? `${parsedFloor[0]}.${parsedFloor[1]}.${parsedFloor[2] ?? 0}`
        : null,
      declaration: source,
      declarationText: entryText,
      authority: "deployment",
    };
    targets.push(target);
    if (!parsedFloor) {
      block("ambiguous-range", `Target ${entry.id} has no unambiguous minimum version.`, source);
      continue;
    }
    const minimum = rule.minimumRuntime[entry.runtime];
    const required = typeof minimum === "string" ? version(minimum, RULE_VERSION) : null;
    if (!required) {
      block("unsupported-target", `Rule has no supported floor for ${entry.runtime}.`, source);
      continue;
    }
    if (!meets(parsedFloor, required))
      block("below-floor", `Target ${entry.id} is below rule minimum ${minimum}.`, source);
  }
  if (targets.length === 0 && blocking.length === 0)
    block("schema-invalid", "No valid targets were enumerated.");
  return result();
}
