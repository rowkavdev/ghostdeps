/** Snapshot-bound, per-pillar accounting of JS/TS matched-API citations.
 * The adapter parses JS; core does not. A digest proves cited bytes in the
 * verified scanner view, not that a parser's semantic interpretation is true.
 * No result from this module seals eligibility or emits a finding.
 */
import { createHash } from "node:crypto";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import type { NativeRule } from "./index.js";
import type { NativeMatchedApi, NativeSourceProof } from "./producer.js";
import { verifyNativeSnapshot } from "./snapshot.js";

/** Structural input keeps core independent of the JS/TS adapter package. */
export interface NativeReferenceSpan {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}
export interface NativeReferenceRecord {
  readonly packageName: string;
  readonly binding: string;
  readonly callTarget: string;
  readonly api: string;
  readonly resolution:
    "direct" | "alias" | "wrapper" | "re-export" | "script" | "config" | "indirect-unknown";
  readonly lineage: readonly {
    readonly kind: "import" | "require" | "alias" | "wrapper" | "re-export";
    readonly name: string;
    readonly span: NativeReferenceSpan;
  }[];
  readonly arguments: "inspected" | "unknown";
  readonly options: "inspected" | "unknown";
  readonly span?: NativeReferenceSpan;
  /** One cited span per argument; complete ordered coverage is reconstructed. */
  readonly argumentSpans?: readonly NativeReferenceSpan[];
  readonly note?: string;
}
export interface NativeReferenceScan {
  readonly packageName: string;
  readonly references: readonly NativeReferenceRecord[];
  readonly limitations: readonly unknown[];
}
export interface NativeAccountedReference {
  readonly resolution: "script" | "config";
  readonly source: NativeSourceProof;
  readonly ruleId: string;
  readonly ruleSurface: "cli" | "config";
  readonly ruleCitation: string;
}
export interface NativeMatchedApiBlock {
  readonly reason:
    | "snapshot-unverified"
    | "scan-incomplete"
    | "invalid-reference"
    | "citation-unverified"
    | "citation-inconsistent"
    | "unresolved-reference"
    | "uninspected-use"
    | "unsupported-surface";
  readonly referenceIndex?: number;
  readonly detail: string;
}
export type NativeMatchedApiResult =
  | {
      readonly status: "blocked";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted" | "verified";
      readonly policy: string | null;
      readonly matchedApis: readonly NativeMatchedApi[];
      readonly accounted: readonly NativeAccountedReference[];
      readonly blocking: readonly [NativeMatchedApiBlock, ...NativeMatchedApiBlock[]];
    }
  | {
      readonly status: "pass";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted" | "verified";
      readonly policy: string | null;
      readonly matchedApis: readonly NativeMatchedApi[];
      readonly accounted: readonly NativeAccountedReference[];
      readonly blocking: readonly [];
    };

/** No rule-wide inference: exclusions must be authored on the versioned rule. */
export interface NativeReferenceSurface {
  readonly cli: "covered" | "excluded";
  readonly config: "covered" | "excluded";
  /** Stable rule-authored citation explaining the surface boundary. */
  readonly cliCitation?: string;
  readonly configCitation?: string;
}
const validPath = (file: string): boolean =>
  file.length > 0 &&
  !file.startsWith("/") &&
  !file.includes("\\") &&
  file.normalize("NFC") === file &&
  file.split("/").every((p) => p !== "" && p !== "." && p !== "..");

/** Offset reconstruction of the adapter's call citation. No JS parser runs here.
 * Strings, templates and nested parentheses are opaque argument bytes; all
 * bytes outside arguments must be the single callee and call punctuation.
 */
function reconstructCall(
  bytes: Uint8Array,
  call: NativeReferenceSpan,
  args: readonly NativeReferenceSpan[],
  api: string,
  binding: string,
): string | null {
  const text = (start: number, end: number): string | null => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
    } catch {
      return null;
    }
  };
  const raw = text(call.start, call.end);
  if (raw === null || !raw.endsWith(")")) return "call is not valid UTF-8 ending in a close paren";
  const open = raw.indexOf("(");
  if (open < 0) return "call has no open paren";
  const head = raw.slice(0, open);
  // The head contains identifiers and member selectors, not statements,
  // literals or argument bytes. Nontrivial syntax is blocked, not guessed.
  if (
    !/^[\p{ID_Start}_$][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}$]*)*$/u.test(head)
  )
    return "callee head is not a simple identifier/member chain";
  const finalMember = head.split(".").at(-1)!;
  // A receiver token never proves the claimed API on a member call. A
  // bare identifier can name a local alias or wrapper; its binding link
  // remains the adapter's responsibility, not a claim made by core.
  const local = binding.split(".").at(-1);
  if (head.includes(".") ? finalMember !== api : head !== api && head !== local)
    return "callee final member or local binding does not match the claimed API";
  const innerStart = call.start + Buffer.byteLength(raw.slice(0, open + 1));
  const innerEnd = call.end - 1;
  let cursor = innerStart;
  for (const [index, arg] of args.entries()) {
    if (
      arg.file !== call.file ||
      arg.start < innerStart ||
      arg.end > innerEnd ||
      arg.start < cursor
    )
      return "arguments overlap, are unordered or escape call parentheses";
    const gap = text(cursor, arg.start);
    if (gap === null || !(index === 0 ? /^\s*$/u : /^\s*,\s*$/u).test(gap))
      return "unaccounted bytes before argument";
    cursor = arg.end;
  }
  const tail = text(cursor, innerEnd);
  if (tail === null || !/^\s*$/u.test(tail)) return "unaccounted bytes after arguments";
  return null;
}

export async function collectNativeMatchedApiEvidence(
  repository: RepositoryHandle,
  rule: NativeRule,
  snapshotSha256: string,
  scan: NativeReferenceScan,
): Promise<NativeMatchedApiResult> {
  const matchedApis: NativeMatchedApi[] = [];
  const accounted: NativeAccountedReference[] = [];
  const blocking: NativeMatchedApiBlock[] = [];
  let binding: "caller-asserted" | "verified" = "caller-asserted";
  let policy: string | null = null;
  const block = (
    reason: NativeMatchedApiBlock["reason"],
    detail: string,
    referenceIndex?: number,
  ) =>
    blocking.push({ reason, detail, ...(referenceIndex === undefined ? {} : { referenceIndex }) });
  const finish = (): NativeMatchedApiResult =>
    blocking.length
      ? {
          status: "blocked",
          snapshotSha256,
          binding,
          policy,
          matchedApis,
          accounted,
          blocking: blocking as [NativeMatchedApiBlock, ...NativeMatchedApiBlock[]],
        }
      : { status: "pass", snapshotSha256, binding, policy, matchedApis, accounted, blocking: [] };
  const initial = await verifyNativeSnapshot(repository, snapshotSha256);
  if (initial.status !== "verified") {
    block("snapshot-unverified", initial.reason);
    return finish();
  }
  binding = "verified";
  policy = initial.policy;
  if (
    !scan ||
    !Array.isArray(scan.references) ||
    !Array.isArray(scan.limitations) ||
    scan.limitations.length ||
    scan.packageName !== rule.packages.find((p) => p === scan.packageName)
  ) {
    block("scan-incomplete", "Scan limitations, malformed scan, or package outside rule");
    return finish();
  }
  // Only regular files in the verified scanner view are eligible citations.
  // readFileBytes on an arbitrary path (or a symlink) is not snapshot proof.
  let files: Map<string, RepositoryTreeEntry>;
  try {
    const listing = await repository.listEntries?.();
    if (!listing?.complete || listing.limitations.length || listing.policy !== policy) {
      block("snapshot-unverified", "Citation file listing unavailable");
      return finish();
    }
    files = new Map(
      listing.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]),
    );
  } catch {
    block("snapshot-unverified", "Citation file listing failed");
    return finish();
  }
  const bytesByFile = new Map<string, Uint8Array>();
  const proof = async (span: NativeReferenceSpan): Promise<NativeSourceProof | null> => {
    if (
      !span ||
      typeof span.file !== "string" ||
      !validPath(span.file) ||
      !files.has(span.file) ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start
    )
      return null;
    let bytes = bytesByFile.get(span.file);
    if (!bytes) {
      if (!repository.readFileBytes) return null;
      try {
        bytes = await repository.readFileBytes(span.file, files.get(span.file));
      } catch {
        return null;
      }
      if (!(bytes instanceof Uint8Array)) return null;
      bytesByFile.set(span.file, bytes);
    }
    if (span.end > bytes.length) return null;
    const prefix = bytes.subarray(0, span.start);
    return {
      snapshotSha256,
      file: span.file,
      line: 1 + prefix.reduce((n, b) => n + (b === 10 ? 1 : 0), 0),
      span: {
        sha256: createHash("sha256").update(bytes.subarray(span.start, span.end)).digest("hex"),
      },
    };
  };
  for (const [index, ref] of scan.references.entries()) {
    if (
      !ref ||
      ref.packageName !== scan.packageName ||
      typeof ref.binding !== "string" ||
      !ref.binding ||
      typeof ref.callTarget !== "string" ||
      !ref.callTarget ||
      typeof ref.api !== "string" ||
      !ref.api ||
      !Array.isArray(ref.lineage)
    ) {
      block("invalid-reference", "Missing identity or lineage", index);
      continue;
    }
    if (!ref.span) {
      block("unresolved-reference", "Reference has no locatable citation", index);
      continue;
    }
    const source = await proof(ref.span);
    const lineage = await Promise.all(
      ref.lineage.map((hop: NativeReferenceRecord["lineage"][number]) => proof(hop?.span)),
    );
    const args = Array.isArray(ref.argumentSpans)
      ? await Promise.all(ref.argumentSpans.map(proof))
      : null;
    if (
      !source ||
      lineage.some((p) => !p) ||
      (args && args.some((p) => !p)) ||
      ref.lineage.some(
        (hop: NativeReferenceRecord["lineage"][number]) =>
          !hop ||
          !["import", "require", "alias", "wrapper", "re-export"].includes(hop.kind) ||
          typeof hop.name !== "string" ||
          !hop.name,
      )
    ) {
      block(
        "citation-unverified",
        "A call, lineage or argument span could not be read as repository bytes",
        index,
      );
      continue;
    }
    if (ref.resolution === "indirect-unknown") {
      block("unresolved-reference", ref.note ?? "Indirect reference not resolved", index);
      continue;
    }
    if (ref.resolution === "script" || ref.resolution === "config") {
      const surface = ref.resolution === "script" ? "cli" : "config";
      const declared = rule.referenceSurface;
      const citation = surface === "cli" ? declared?.cliCitation : declared?.configCitation;
      if (
        ref.lineage.length ||
        ref.argumentSpans !== undefined ||
        ref.api !== (surface === "cli" ? "<script>" : "<config>")
      ) {
        block("invalid-reference", "Non-call reference has unexpected call citations", index);
      } else if (
        declared?.[surface] === "excluded" &&
        citation &&
        citation.startsWith(rule.id + ":")
      ) {
        accounted.push({
          resolution: ref.resolution,
          source,
          ruleId: rule.id,
          ruleSurface: surface,
          ruleCitation: citation,
        });
      } else {
        block(
          "unsupported-surface",
          `${surface} use has no inspected call arguments or explicit rule exclusion`,
          index,
        );
      }
      continue;
    }
    if (!["direct", "alias", "wrapper", "re-export"].includes(ref.resolution)) {
      block("invalid-reference", "Unknown resolution class", index);
      continue;
    }
    if (ref.arguments !== "inspected" || ref.options !== "inspected" || !args) {
      block("uninspected-use", "Call arguments or options have not been inspected", index);
      continue;
    }
    if (
      !ref.lineage.length ||
      !ref.lineage.some((hop: NativeReferenceRecord["lineage"][number]) =>
        ["import", "require"].includes(hop.kind),
      ) ||
      (ref.resolution === "wrapper" &&
        !ref.lineage.some(
          (hop: NativeReferenceRecord["lineage"][number]) => hop.kind === "wrapper",
        )) ||
      (ref.resolution === "re-export" &&
        !ref.lineage.some(
          (hop: NativeReferenceRecord["lineage"][number]) => hop.kind === "re-export",
        )) ||
      ref.api.startsWith("<") ||
      !rule.coveredApis.includes(ref.api) ||
      ref.argumentSpans!.some(
        (arg: NativeReferenceSpan) =>
          arg.file !== ref.span!.file || arg.start < ref.span!.start || arg.end > ref.span!.end,
      )
    ) {
      block(
        "unresolved-reference",
        "API, lineage or argument bounds do not establish a covered call",
        index,
      );
      continue;
    }
    if (ref.resolution !== "wrapper" && ref.callTarget !== `${ref.packageName}.${ref.api}`) {
      block("unresolved-reference", "Call target does not match package and covered API", index);
      continue;
    }
    const callBytes = bytesByFile.get(ref.span.file);
    const inconsistency =
      callBytes && reconstructCall(callBytes, ref.span, ref.argumentSpans!, ref.api, ref.binding);
    if (!callBytes || inconsistency) {
      block("citation-inconsistent", inconsistency ?? "call bytes unavailable", index);
      continue;
    }
    matchedApis.push({
      packageName: ref.packageName,
      binding: ref.binding,
      callTarget: ref.callTarget,
      api: ref.api,
      source,
      arguments: "inspected",
      options: "inspected",
      resolution: ref.resolution,
      lineage: lineage as NativeSourceProof[],
      argumentSources: args,
    });
  }
  // A citation read is only snapshot-bound if the repository still matches
  // after the separate byte reads. Never return positive records on a race.
  const final = await verifyNativeSnapshot(repository, snapshotSha256);
  if (final.status !== "verified" || final.policy !== policy) {
    binding = "caller-asserted";
    policy = null;
    matchedApis.length = 0;
    accounted.length = 0;
    block("snapshot-unverified", final.status === "verified" ? "policy-changed" : final.reason);
  }
  return finish();
}
