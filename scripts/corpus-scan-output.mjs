/**
 * Parse one scan's --json stdout (#172 audit). Every malformed shape the CLI
 * could emit at exit 0 - unparseable text, null, an array, an object without
 * a findings array, a malformed finding entry - comes back as an actionable
 * error naming the broken CLI contract, never a thrown TypeError downstream.
 * Shared by scripts/corpus.mjs and exercised directly by the regression test
 * so the harness's real parse path is what CI pins.
 */
export function parseScanOutput(code, stdout) {
  if (code !== 0) return { result: undefined };
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {
      error:
        "scan exited 0 but its --json output was not parseable - the CLI contract broke; investigate before touching any golden",
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const what = value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
    return {
      error: `scan exited 0 but its --json output was ${what} - expected an object with a findings array`,
    };
  }
  if (!Array.isArray(value.findings)) {
    return {
      error:
        "scan exited 0 but its --json output has no findings array - expected { findings: [...] }",
    };
  }
  const bad = value.findings.findIndex(
    (f) =>
      typeof f?.kind !== "string" ||
      (f.severity !== undefined && typeof f.severity !== "string") ||
      (f.dependency !== undefined && typeof f.dependency !== "string" && f.dependency !== null),
  );
  if (bad !== -1) {
    return {
      error: `scan exited 0 but findings[${bad}] is malformed - expected { kind: string, severity?: string, dependency?: string|null }`,
    };
  }
  return { result: value };
}
