/**
 * PEP 508 requirement strings, parsed as text only. Nothing here resolves,
 * fetches or evaluates: markers are kept verbatim, URLs are recorded.
 */

export interface Requirement {
  /** Name as written. */
  rawName: string;
  /** PEP 503 normalised name. */
  name: string;
  extras: string[];
  /** PEP 440 specifier set as written, "" when unconstrained. */
  specifier: string;
  /** Direct reference (`name @ url`), when present. */
  url?: string;
  /** Environment marker, verbatim. */
  marker?: string;
}

/** PEP 503: lowercase, runs of -, _ and . collapse to one "-". */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;

/** Parse one PEP 508 string. Returns undefined when it is not a requirement. */
export function parseRequirement(input: string): Requirement | undefined {
  let text = input.trim();
  if (text.length === 0 || text.length > 4096) return undefined;

  let marker: string | undefined;
  const semicolon = text.indexOf(";");
  if (semicolon !== -1) {
    marker = text.slice(semicolon + 1).trim() || undefined;
    text = text.slice(0, semicolon).trim();
  }

  const nameMatch = NAME.exec(text);
  if (!nameMatch?.[1]) return undefined;
  const rawName = nameMatch[1];
  let rest = text.slice(rawName.length).trim();

  let extras: string[] = [];
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return undefined;
    extras = rest
      .slice(1, close)
      .split(",")
      .map((extra) => extra.trim())
      .filter((extra) => extra.length > 0)
      .map(normaliseName);
    rest = rest.slice(close + 1).trim();
  }

  let url: string | undefined;
  let specifier = "";
  if (rest.startsWith("@")) {
    url = rest.slice(1).trim();
    if (url.length === 0) return undefined;
  } else {
    if (rest.startsWith("(") && rest.endsWith(")")) rest = rest.slice(1, -1).trim();
    if (rest.length > 0 && !/^(?:[<>=!~]=?|===)/.test(rest)) return undefined;
    specifier = rest.replace(/\s+/g, "");
  }

  const requirement: Requirement = { rawName, name: normaliseName(rawName), extras, specifier };
  if (url !== undefined) requirement.url = url;
  if (marker !== undefined) requirement.marker = marker;
  return requirement;
}
