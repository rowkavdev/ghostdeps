function byteEscape(source: string, start: number): { byte: number; end: number } | undefined {
  const hex = source[start + 1] === "x";
  const offset = hex ? 2 : 1;
  const digits = hex ? 2 : 3;
  const raw = source.slice(start + offset, start + offset + digits);
  if (raw.length !== digits || !(hex ? /^[0-9a-fA-F]{2}$/ : /^[0-7]{3}$/).test(raw))
    return undefined;
  const byte = Number.parseInt(raw, hex ? 16 : 8);
  return byte <= 255 ? { byte, end: start + offset + digits } : undefined;
}

type DecodedEscape = { value: string; end: number };

const SIMPLE: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

function decodeBytes(source: string, start: number): DecodedEscape | undefined {
  const first = byteEscape(source, start);
  if (!first) return undefined;
  const bytes = [first.byte];
  let end = first.end;
  while (source[end] === "\\") {
    const next = byteEscape(source, end);
    if (!next) break;
    bytes.push(next.byte);
    end = next.end;
  }
  try {
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)), end };
  } catch {
    // Invalid UTF-8 cannot manufacture a valid import path.
    return { value: source.slice(start, end), end };
  }
}

function decodeUnicode(source: string, start: number): DecodedEscape | undefined {
  const kind = source[start + 1];
  const digits = kind === "u" ? 4 : kind === "U" ? 8 : 0;
  if (!digits) return undefined;
  const raw = source.slice(start + 2, start + 2 + digits);
  if (raw.length !== digits || !/^[0-9a-fA-F]+$/.test(raw)) return undefined;
  const code = Number.parseInt(raw, 16);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return { value: String.fromCodePoint(code), end: start + 2 + digits };
}

/** Decode Go interpreted string escapes without executing source. */
export function decodeGoEscape(source: string, start: number): DecodedEscape {
  const kind = source[start + 1] ?? "";
  if (Object.hasOwn(SIMPLE, kind)) return { value: SIMPLE[kind]!, end: start + 2 };
  return (
    decodeBytes(source, start) ??
    decodeUnicode(source, start) ?? {
      // Keep invalid syntax literal instead of inventing another import path.
      value: source.slice(start, start + 2),
      end: start + 2,
    }
  );
}
