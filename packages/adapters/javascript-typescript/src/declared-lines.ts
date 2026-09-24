/**
 * Declaration lines for package.json dependency entries (#198 slice B).
 *
 * A linear scan over the raw manifest text that tracks JSON nesting and
 * records the 1-based line of each key directly inside a top-level
 * dependency section. It only runs on text JSON.parse already accepted, and
 * it never evaluates anything. On a duplicate key the last one wins, which
 * matches JSON.parse. Core re-checks every line against the manifest (#198
 * slice A), so a wrong line here is dropped, never shown.
 */
export function scanDeclaredLines(
  text: string,
  sections: ReadonlySet<string>,
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  // Stack of containers: "o" object or "a" array.
  const stack: ("o" | "a")[] = [];
  let line = 1;
  let topKey: string | undefined; // current key at depth 1
  let expectKey = false; // next string in the current object is a key
  let i = 0;
  const n = text.length;

  const readString = (): string => {
    // text[i] is the opening quote.
    let out = "";
    i++;
    while (i < n) {
      const c = text[i]!;
      if (c === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
        out += next !== undefined ? (map[next] ?? next) : "";
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\n") line++;
      out += c;
      i++;
    }
    return out;
  };

  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
    } else if (c === "{") {
      stack.push("o");
      expectKey = true;
      i++;
    } else if (c === "[") {
      stack.push("a");
      expectKey = false;
      i++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 1) topKey = undefined;
      expectKey = false;
      i++;
    } else if (c === ",") {
      expectKey = stack[stack.length - 1] === "o";
      i++;
    } else if (c === '"') {
      const keyLine = line;
      const value = readString();
      if (expectKey) {
        expectKey = false;
        if (stack.length === 1) {
          topKey = value;
        } else if (stack.length === 2 && topKey !== undefined && sections.has(topKey)) {
          let byName = result.get(topKey);
          if (byName === undefined) result.set(topKey, (byName = new Map()));
          byName.set(value, keyLine);
        }
      }
    } else {
      i++;
    }
  }
  return result;
}
