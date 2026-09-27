/** Slice 5b: bounded per-pattern checks. This is a pillar, never a verdict. */
import { createHash } from "node:crypto";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import type { NativeRule } from "./index.js";
import type {
  NativeIncompatibleCheck,
  NativeNegativeProof,
  NativeSourceProof,
  NativeInspectedScope,
} from "./producer.js";
import { verifyNativeSnapshot } from "./snapshot.js";

export interface NativePatternSpan {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}
export interface NativePatternInspection {
  readonly patternId: string;
  readonly kind: "member-call" | "option-key-value" | "property-chain";
  readonly inspectedFiles: readonly string[];
  readonly inspectedBytes: number;
  readonly capped: boolean;
  readonly observations: readonly NativePatternSpan[];
  readonly uninspectable: readonly (NativePatternSpan & { readonly note: string })[];
  readonly state: "observed" | "not-observed" | "uninspectable";
}
export interface NativeIncompatibleBlock {
  readonly patternId: string;
  readonly reason:
    | "snapshot-unverified"
    | "missing-inspection"
    | "incomplete-scope"
    | "citation-inconsistent"
    | "uninspectable"
    | "observed";
  readonly detail: string;
}
/** Byte/scope validation is core-owned. Pattern semantics and package lineage
 * remain adapter-asserted. A pass cannot seal a producer envelope.
 */
export type NativeIncompatibleResult =
  | {
      readonly status: "blocked";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted" | "verified";
      readonly lineageVerification: "adapter-asserted";
      readonly policy: string | null;
      readonly checks: readonly NativeIncompatibleCheck[];
      readonly blocking: readonly [NativeIncompatibleBlock, ...NativeIncompatibleBlock[]];
    }
  | {
      readonly status: "pass";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted" | "verified";
      readonly lineageVerification: "adapter-asserted";
      readonly policy: string | null;
      readonly checks: readonly NativeIncompatibleCheck[];
      readonly blocking: readonly [];
    };

const sha = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const frame = (value: Uint8Array | string): Buffer => {
  const data = Buffer.from(value);
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(data.length));
  return Buffer.concat([len, data]);
};
const extensions = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];
const excluded = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const eligible = (file: string): boolean =>
  extensions.some((ext) => file.endsWith(ext)) &&
  !file.split("/").some((part) => excluded.has(part));
const safe = (file: string): boolean =>
  file.length > 0 &&
  !file.startsWith("/") &&
  !file.includes("\\") &&
  file.normalize("NFC") === file &&
  file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const MAX_FILES = 2_000;
const MAX_BYTES = 8_000_000;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_OBSERVATIONS = 1_000;
const exact = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** Matches the snapshot v1 length-prefix framing: sorted paths and raw bytes
 * are domain-separated. This digest covers eligibility and exact snapshot
 * listing, including a zero-eligible-file listing.
 */
function negativeProof(
  snapshotSha256: string,
  policy: string,
  listingSha256: string,
  patternId: string,
  kind: NativePatternInspection["kind"],
  files: NativeNegativeProof["files"],
): NativeNegativeProof {
  const h = createHash("sha256")
    .update("ghostdeps-native-negative-v1\0")
    .update(Buffer.from(snapshotSha256, "hex"))
    .update(Buffer.from(policy, "hex"))
    .update(Buffer.from(listingSha256, "hex"))
    .update(frame("js-ts-pattern-files-v1"))
    .update(frame(patternId))
    .update(frame(kind));
  for (const file of files) {
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(file.byteLength));
    h.update("F").update(frame(file.path)).update(size).update(Buffer.from(file.sha256, "hex"));
  }
  return {
    snapshotSha256,
    policy,
    patternId,
    kind,
    eligibility: "js-ts-pattern-files-v1",
    listingSha256,
    files,
    sha256: h.digest("hex"),
  };
}

export async function collectNativeIncompatibleEvidence(
  repository: RepositoryHandle,
  rule: NativeRule,
  snapshotSha256: string,
  inspections: readonly NativePatternInspection[],
): Promise<NativeIncompatibleResult> {
  const checks: NativeIncompatibleCheck[] = [];
  const blocking: NativeIncompatibleBlock[] = [];
  let binding: "caller-asserted" | "verified" = "caller-asserted";
  let policy: string | null = null;
  const block = (
    patternId: string,
    reason: NativeIncompatibleBlock["reason"],
    detail: string,
  ): void => {
    blocking.push({ patternId, reason, detail });
  };
  const finish = (): NativeIncompatibleResult =>
    blocking.length
      ? {
          status: "blocked",
          snapshotSha256,
          binding,
          lineageVerification: "adapter-asserted",
          policy,
          checks,
          blocking: blocking as [NativeIncompatibleBlock, ...NativeIncompatibleBlock[]],
        }
      : {
          status: "pass",
          snapshotSha256,
          binding,
          lineageVerification: "adapter-asserted",
          policy,
          checks,
          blocking: [],
        };
  const verified = await verifyNativeSnapshot(repository, snapshotSha256);
  if (verified.status !== "verified") {
    block("*", "snapshot-unverified", verified.reason);
    return finish();
  }
  binding = "verified";
  policy = verified.policy;
  let entries: RepositoryTreeEntry[];
  try {
    const listing = await repository.listEntries?.();
    if (
      !listing?.complete ||
      listing.limitations.length ||
      listing.policy !== policy ||
      !Array.isArray(listing.entries)
    )
      throw Error();
    entries = [...listing.entries];
  } catch {
    block("*", "snapshot-unverified", "Verified listing unavailable");
    return finish();
  }
  const sorted = entries
    .filter((e) => e.kind === "file" && eligible(e.path))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const listed = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  const listingSha256 = sha(
    Buffer.concat(
      listed.map((e) =>
        Buffer.concat([
          frame(e.path),
          frame(e.kind),
          frame(e.target ?? ""),
          frame(String(e.size ?? "")),
        ]),
      ),
    ),
  );
  const expected = sorted.map((e) => e.path);
  // The adapter walks listFiles(), not listEntries(). A custom handle may
  // present a different scanner view; that cannot prove a negative.
  let listMatches = false;
  try {
    const seen = (await repository.listFiles())
      .map((file) => file.replace(/^\.\//, ""))
      .filter(eligible)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    listMatches = seen.length === expected.length && seen.every((file, i) => file === expected[i]);
  } catch {
    /* Incomplete view blocks absence. */
  }
  const bytes = new Map<string, Uint8Array>();
  let total = 0;
  let scopeComplete = sorted.length <= MAX_FILES && listMatches;
  for (const entry of sorted) {
    try {
      const value = await repository.readFileBytes?.(entry.path, entry);
      if (!(value instanceof Uint8Array)) throw Error();
      bytes.set(entry.path, value);
      total += value.byteLength;
      if (value.byteLength > MAX_SOURCE_BYTES || total > MAX_BYTES) scopeComplete = false;
    } catch {
      scopeComplete = false;
    }
  }
  const fileProof = sorted.flatMap((e) => {
    const value = bytes.get(e.path);
    return value ? [{ path: e.path, byteLength: value.byteLength, sha256: sha(value) }] : [];
  });
  const proofOf = (span: NativePatternSpan): NativeSourceProof | null => {
    if (
      !span ||
      typeof span.file !== "string" ||
      !safe(span.file) ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start
    )
      return null;
    const value = bytes.get(span.file);
    if (!value || span.end > value.byteLength) return null;
    return {
      snapshotSha256,
      file: span.file,
      line: 1 + value.subarray(0, span.start).reduce((n, b) => n + (b === 10 ? 1 : 0), 0),
      span: { sha256: sha(value.subarray(span.start, span.end)) },
    };
  };
  const all = Array.isArray(inspections) ? inspections : [];
  const ruleValid =
    Array.isArray(rule.incompatibleUses) &&
    rule.incompatibleUses.length > 0 &&
    exact(rule.incompatibleUses);
  for (const patternId of ruleValid ? rule.incompatibleUses : []) {
    const records = all.filter((r) => r?.patternId === patternId);
    const expectedKind = rule.incompatiblePatternKinds?.[patternId];
    const record = records[0];
    const scope: NativeInspectedScope = {
      snapshotSha256,
      files: expected,
      calls: [],
      complete: false,
    };
    const unchecked = (reason: NativeIncompatibleBlock["reason"], detail: string) => {
      checks.push({ patternId, state: "unchecked", scope, locations: [] });
      block(patternId, reason, detail);
    };
    if (
      records.length !== 1 ||
      !record ||
      !expectedKind ||
      record.kind !== expectedKind ||
      !Array.isArray(record.inspectedFiles) ||
      !Array.isArray(record.observations) ||
      !Array.isArray(record.uninspectable) ||
      record.observations.length > MAX_OBSERVATIONS ||
      record.uninspectable.length > MAX_OBSERVATIONS
    ) {
      unchecked("missing-inspection", "Exactly one valid inspection is required");
      continue;
    }
    const observations = (record.observations as NativePatternSpan[]).map(proofOf);
    const unknowns = (record.uninspectable as NativePatternSpan[]).map(proofOf);
    if (
      observations.some((p) => !p) ||
      unknowns.some((p) => !p) ||
      (record.observations as NativePatternSpan[]).some(
        (s) => !reconstruct(s, record.kind, patternId, bytes.get(s.file)!),
      ) ||
      (record.uninspectable as (NativePatternSpan & { note: string })[]).some(
        (s) => typeof s.note !== "string" || !s.note,
      )
    ) {
      unchecked(
        "citation-inconsistent",
        "Observation or unknown citation could not be reconstructed",
      );
      continue;
    }
    const cited = observations as NativeSourceProof[];
    if (
      record.kind !== "member-call" &&
      record.kind !== "option-key-value" &&
      record.kind !== "property-chain"
    ) {
      unchecked("missing-inspection", "Unsupported pattern kind");
      continue;
    }
    const same =
      record.inspectedFiles.length === expected.length &&
      (record.inspectedFiles as string[]).every((file, i) => file === expected[i]);
    const coverage =
      same &&
      scopeComplete &&
      record.capped === false &&
      record.inspectedBytes === total &&
      fileProof.length === expected.length;
    const stateConsistent =
      record.state ===
      (cited.length ? "observed" : unknowns.length ? "uninspectable" : "not-observed");
    if (!stateConsistent || !coverage) {
      unchecked(
        "incomplete-scope",
        "Inspection state, eligible files, byte count or cap does not match verified scope",
      );
      continue;
    }
    if (cited.length && record.state === "observed") {
      checks.push({
        patternId,
        state: "observed",
        scope,
        locations: cited as [NativeSourceProof, ...NativeSourceProof[]],
      });
      block(patternId, "observed", "Incompatible use observed");
      continue;
    }
    if (cited.length || unknowns.length || record.state !== "not-observed") {
      unchecked(
        unknowns.length ? "uninspectable" : "incomplete-scope",
        "Incomplete, capped or uninspectable coverage",
      );
      continue;
    }
    const complete: NativeInspectedScope & { complete: true } = { ...scope, complete: true };
    checks.push({
      patternId,
      state: "absent",
      scope: complete,
      locations: [],
      negativeProof: negativeProof(
        snapshotSha256,
        policy,
        listingSha256,
        patternId,
        record.kind,
        fileProof,
      ),
    });
  }
  if (
    !ruleValid ||
    all.some((r) => !rule.incompatibleUses.includes(r?.patternId)) ||
    Object.keys(rule.incompatiblePatternKinds ?? {}).some((p) => !rule.incompatibleUses.includes(p))
  )
    block("*", "missing-inspection", "Rule/inspection pattern set invalid");
  const final = await verifyNativeSnapshot(repository, snapshotSha256);
  if (final.status !== "verified" || final.policy !== policy) {
    binding = "caller-asserted";
    policy = null;
    checks.length = 0;
    block(
      "*",
      "snapshot-unverified",
      final.status === "verified" ? "policy-changed" : final.reason,
    );
  }
  return finish();
}

/** Conservative byte-shape check, not a JS parser or package-binding proof. */
function reconstruct(
  span: NativePatternSpan,
  kind: NativePatternInspection["kind"],
  patternId: string,
  bytes: Uint8Array,
): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(span.start, span.end));
  } catch {
    return false;
  }
  const id = patternId.replace(/\[\*\]/g, "").replace(/\(.*$/, "");
  if (kind === "option-key-value")
    return new RegExp(
      `^(?:${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|"${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}")\\s*:`,
    ).test(text);
  if (kind === "member-call") {
    if (!text.endsWith(")") || !text.includes("(")) return false;
    const head = text.slice(0, text.indexOf("("));
    const wanted = id.split(".");
    const parts = head.split(".");
    return (
      wanted.every((part, i) => parts[parts.length - wanted.length + i] === part) ||
      (parts.length > wanted.length &&
        parts.at(-1) === "use" &&
        wanted.every((part, i) => parts[parts.length - wanted.length - 1 + i] === part))
    );
  }
  return text === id || text.endsWith(`.${id}`);
}
