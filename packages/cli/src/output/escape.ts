/**
 * Terminal escape for repository- or adapter-derived text (security-model
 * rule 6: "CLI output is escaped"). Manifest fields are attacker-controlled;
 * raw ESC sequences (OSC 8 hyperlinks, cursor moves, screen clears) and bidi
 * or zero-width tricks would be interpreted by the user's terminal.
 *
 * Anything analysis-derived that reaches a human goes through here. JSON
 * output has its own escaping in core's reporter.
 */

/** C0 controls, DEL + C1, bidi controls, zero-width characters. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Replace terminal-dangerous characters with U+FFFD so tampering is visible. */
export function escapeTerminal(text: string): string {
  return text.replace(UNSAFE, "�");
}
