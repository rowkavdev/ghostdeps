/**
 * Bounded, versioned wire contract for a future disposable analysis child (#326).
 * This module does not launch or sandbox a process. It is deliberately separate
 * from the current worker-thread engine until the OS boundary is verified.
 */
import { TextDecoder } from "node:util";

export const ANALYSIS_PROTOCOL_VERSION = 1;
export const MAX_ANALYSIS_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_ANALYSIS_INPUT_BYTES = 1024 * 1024;
const MAX_DEPTH = 24;
const MAX_STRING_LENGTH = 16_384;
const MAX_ARRAY_LENGTH = 50_000;
const MAX_OBJECT_KEYS = 128;

export const BUILTIN_ADAPTER_IDS = ["javascript-typescript", "python", "rust", "go"] as const;
export type BuiltinAdapterId = (typeof BUILTIN_ADAPTER_IDS)[number];

/** No host paths, module specifiers, URLs or credentials cross this contract. */
export interface AnalysisRequest {
  version: 1;
  jobId: string;
  checkoutSha256: string;
  adapters: BuiltinAdapterId[];
}

export interface AnalysisResponse {
  version: 1;
  jobId: string;
  status: "complete" | "incomplete";
  /** Bounded but not yet trusted or renderable. A later slice must validate the exact result schema. */
  result: unknown;
}

export class AnalysisProtocolError extends Error {
  constructor(readonly code: string) {
    super(`analysis protocol rejected: ${code}`);
    this.name = "AnalysisProtocolError";
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

export function validateAnalysisRequest(value: unknown): AnalysisRequest {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["version", "jobId", "checkoutSha256", "adapters"])
  ) {
    throw new AnalysisProtocolError("BAD_REQUEST_SHAPE");
  }
  if (
    value.version !== ANALYSIS_PROTOCOL_VERSION ||
    typeof value.jobId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.jobId) ||
    typeof value.checkoutSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checkoutSha256) ||
    !Array.isArray(value.adapters) ||
    value.adapters.length === 0 ||
    value.adapters.length > BUILTIN_ADAPTER_IDS.length ||
    !value.adapters.every((id: unknown) => BUILTIN_ADAPTER_IDS.some((allowed) => allowed === id)) ||
    new Set(value.adapters).size !== value.adapters.length
  ) {
    throw new AnalysisProtocolError("BAD_REQUEST_VALUE");
  }
  return value as unknown as AnalysisRequest;
}

/** Validate size before any JSON parse; cap nested surfaces before the reporter sees them. */
function boundedJson(value: unknown, depth: number, budget: { nodes: number }): void {
  budget.nodes++;
  if (budget.nodes > 200_000 || depth > MAX_DEPTH)
    throw new AnalysisProtocolError("RESULT_COMPLEXITY");
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new AnalysisProtocolError("RESULT_STRING");
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AnalysisProtocolError("RESULT_NUMBER");
  } else if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) throw new AnalysisProtocolError("RESULT_ARRAY");
    for (const item of value) boundedJson(item, depth + 1, budget);
  } else if (plainRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) throw new AnalysisProtocolError("RESULT_KEYS");
    for (const key of keys) {
      if (key.length > 256 || key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new AnalysisProtocolError("RESULT_KEY");
      }
      boundedJson(value[key], depth + 1, budget);
    }
  } else if (value !== null && typeof value !== "boolean") {
    throw new AnalysisProtocolError("RESULT_TYPE");
  }
}

export function validateAnalysisResponse(value: unknown, expectedJobId: string): AnalysisResponse {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["version", "jobId", "status", "result"]) ||
    value.version !== ANALYSIS_PROTOCOL_VERSION ||
    value.jobId !== expectedJobId ||
    (value.status !== "complete" && value.status !== "incomplete") ||
    !plainRecord(value.result)
  ) {
    throw new AnalysisProtocolError("BAD_RESPONSE_SHAPE");
  }
  boundedJson(value.result, 0, { nodes: 0 });
  return value as unknown as AnalysisResponse;
}

/** Four-byte BE length followed by one UTF-8 JSON frame, no trailing bytes. */
export function decodeAnalysisFrame(frame: Uint8Array, expectedJobId: string): AnalysisResponse {
  if (frame.byteLength < 4 || frame.byteLength > MAX_ANALYSIS_FRAME_BYTES + 4) {
    throw new AnalysisProtocolError("FRAME_SIZE");
  }
  const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
  if (length === 0 || length > MAX_ANALYSIS_FRAME_BYTES || length !== frame.byteLength - 4) {
    throw new AnalysisProtocolError("FRAME_LENGTH");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4)));
  } catch {
    throw new AnalysisProtocolError("FRAME_JSON");
  }
  return validateAnalysisResponse(parsed, expectedJobId);
}

export function encodeAnalysisRequest(value: unknown): Uint8Array {
  const request = validateAnalysisRequest(value);
  const body = Buffer.from(JSON.stringify(request), "utf8");
  if (body.length > MAX_ANALYSIS_INPUT_BYTES) throw new AnalysisProtocolError("REQUEST_SIZE");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}
