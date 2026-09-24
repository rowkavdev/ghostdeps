import type { Dependency, Finding } from "../types/index.js";

/** At most this many adapter notes per run, across all adapters (#205). */
export const MAX_ADAPTER_NOTES = 100;
/** Longer statements are cut to this many characters. */
export const MAX_ADAPTER_NOTE_CHARS = 300;

// C0/C1 controls, bidi overrides and zero-width characters (#205: adapter
// text is untrusted; presenters escape markdown, this keeps it one line).
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;

function cleanStatement(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_ADAPTER_NOTE_CHARS
    ? `${text.slice(0, MAX_ADAPTER_NOTE_CHARS - 1)}…`
    : text;
}

export interface AdapterNoteSource {
  ecosystem: string;
  /** Raw EcosystemAdapter.notes() output. */
  notes: unknown;
  /** What this adapter listed; a capability note must name one of these. */
  dependencies: readonly Dependency[];
}

/**
 * Map adapter notes (#205) into core info findings. Never capping:
 *
 * - A note naming a dependency the same adapter listed becomes an
 *   "adapter-capability" finding with `awareness: true` (lead ruling on
 *   #205; no change suggested, never costs the check).
 * - A note with no dependency becomes an "adapter-note" run note with
 *   `adapterNote: true` (findingGroup "note", #239): shown in Notes, never
 *   "Analysis incomplete".
 *
 * Malformed notes and notes naming a dependency the adapter did not list
 * are dropped. Identical notes are deduped. Past MAX_ADAPTER_NOTES, one
 * run note says how many were dropped.
 */
export function adapterNoteFindings(sources: readonly AdapterNoteSource[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  let dropped = 0;
  for (const source of sources) {
    if (!Array.isArray(source.notes)) continue;
    const listed = new Set(source.dependencies.map((d) => d.name));
    for (const raw of source.notes as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const note = raw as Record<string, unknown>;
      const statement = cleanStatement(note.statement);
      if (statement === undefined) continue;
      let dependency: string | undefined;
      if (note.dependency !== undefined) {
        if (typeof note.dependency !== "string" || !listed.has(note.dependency)) continue;
        dependency = note.dependency;
      }
      const key = JSON.stringify([source.ecosystem, dependency ?? null, statement]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length >= MAX_ADAPTER_NOTES) {
        dropped++;
        continue;
      }
      out.push(
        dependency !== undefined
          ? {
              kind: "info",
              rule: "adapter-capability",
              dependency,
              summary: `${dependency}: ${statement}`,
              recommendation: "For awareness only; no change is suggested.",
              evidence: [
                {
                  kind: "adapter-note",
                  statement: `${source.ecosystem} adapter: ${statement}`,
                },
              ],
              confidence: "high",
              awareness: true,
              limitations: [],
              affectedFiles: [],
            }
          : {
              kind: "info",
              rule: "adapter-note",
              summary: `${source.ecosystem}: ${statement}`,
              recommendation: "For information; no change is suggested.",
              evidence: [
                {
                  kind: "adapter-note",
                  statement: `${source.ecosystem} adapter: ${statement}`,
                },
              ],
              confidence: "high",
              adapterNote: true,
              limitations: [],
              affectedFiles: [],
            },
      );
    }
  }
  if (dropped > 0) {
    out.push({
      kind: "info",
      rule: "adapter-note",
      summary: `${dropped} more adapter note(s) not shown (limit ${MAX_ADAPTER_NOTES} per run)`,
      recommendation: "For information; no change is suggested.",
      evidence: [
        {
          kind: "adapter-notes-capped",
          statement: `${dropped} adapter note(s) past the per-run limit were dropped`,
        },
      ],
      confidence: "high",
      adapterNote: true,
      limitations: [],
      affectedFiles: [],
    });
  }
  return out;
}
