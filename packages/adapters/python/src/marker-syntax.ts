/**
 * Whether a string is a syntactically valid PEP 508 environment marker.
 * Syntax only: variables and strings are not evaluated. Pipfile shorthand
 * values are joined into marker text, and pipenv discards a combined marker
 * that does not parse, so the reader needs the same test.
 */
const VARIABLES = new Set([
  "python_version",
  "python_full_version",
  "os_name",
  "sys_platform",
  "platform_release",
  "platform_system",
  "platform_version",
  "platform_machine",
  "platform_python_implementation",
  "implementation_name",
  "implementation_version",
  "extra",
  // Legacy dotted spellings that packaging still accepts.
  "os.name",
  "sys.platform",
  "platform.version",
  "platform.machine",
  "platform.python_implementation",
  "python_implementation",
]);

const TOKEN =
  /\s*(?:('[^'\n\r]*'|"[^"\n\r]*")|(===|==|!=|<=|>=|~=|<|>)|(\()|(\))|([A-Za-z_][A-Za-z0-9_.]*))/y;

/** Nesting beyond this is treated as invalid rather than recursing without bound. */
const MAX_DEPTH = 64;

export function isValidMarker(text: string): boolean {
  const tokens: { kind: "str" | "op" | "open" | "close" | "word"; value: string }[] = [];
  TOKEN.lastIndex = 0;
  let position = 0;
  while (position < text.length) {
    if (/^\s*$/.test(text.slice(position))) break;
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(text);
    if (match === null) return false;
    position = TOKEN.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: "str", value: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "op", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: "open", value: "(" });
    else if (match[4] !== undefined) tokens.push({ kind: "close", value: ")" });
    else tokens.push({ kind: "word", value: match[5] as string });
  }

  let index = 0;
  let depth = 0;
  const word = (value: string): boolean => {
    const token = tokens[index];
    if (token?.kind === "word" && token.value === value) {
      index += 1;
      return true;
    }
    return false;
  };
  const variable = (): boolean => {
    const token = tokens[index];
    if (token === undefined) return false;
    if (token.kind === "str" || (token.kind === "word" && VARIABLES.has(token.value))) {
      index += 1;
      return true;
    }
    return false;
  };
  const operator = (): boolean => {
    const token = tokens[index];
    if (token?.kind === "op") {
      index += 1;
      return true;
    }
    if (word("in")) return true;
    if (
      tokens[index]?.kind === "word" &&
      tokens[index]?.value === "not" &&
      tokens[index + 1]?.kind === "word" &&
      tokens[index + 1]?.value === "in"
    ) {
      index += 2;
      return true;
    }
    return false;
  };
  const expression = (): boolean => {
    if (tokens[index]?.kind === "open") {
      index += 1;
      depth += 1;
      if (depth > MAX_DEPTH || !orExpression()) return false;
      depth -= 1;
      if (tokens[index]?.kind !== "close") return false;
      index += 1;
      return true;
    }
    return variable() && operator() && variable();
  };
  const andExpression = (): boolean => {
    if (!expression()) return false;
    while (word("and")) if (!expression()) return false;
    return true;
  };
  const orExpression = (): boolean => {
    if (!andExpression()) return false;
    while (word("or")) if (!andExpression()) return false;
    return true;
  };
  return tokens.length > 0 && orExpression() && index === tokens.length;
}
