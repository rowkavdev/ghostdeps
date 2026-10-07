/**
 * Terminal escape for repository- or adapter-derived text (security-model
 * rule 6: "CLI output is escaped"). Manifest fields are attacker-controlled;
 * raw ESC sequences (OSC 8 hyperlinks, cursor moves, screen clears) and bidi
 * or zero-width tricks would be interpreted by the user's terminal.
 *
 * Anything analysis-derived that reaches a human goes through here. JSON
 * output has its own escaping in core's reporter.
 */

/**
 * C0 controls, DEL + C1, soft hyphen, bidi controls, line/paragraph
 * separators, zero-width and invisible format characters (word joiner,
 * invisible operators, deprecated format controls) and Unicode tag
 * characters. Tag characters also appear inside subdivision-flag emoji
 * (England, Scotland, Wales), which therefore print with replacement
 * characters: an accepted cost, since a tag run is otherwise invisible text.
 */
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

/** Replace terminal-dangerous characters with U+FFFD so tampering is visible. */
export function escapeTerminal(text: string): string {
  return text.replace(UNSAFE, "�");
}
