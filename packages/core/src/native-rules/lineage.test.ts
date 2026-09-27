import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NativeLineageChain, NativeReferenceSpan } from "./matched-api.js";
import { reconstructLineage } from "./lineage.js";

const src: Record<string, string> = {
  "src/use.ts": 'import { get as g } from "axios";\nconst a = g;\na("/x");',
  "src/req.cjs": 'const { get: g } = require("axios"); g("/x");',
  "src/one.ts": 'export { get as g } from "axios";',
  "src/two.ts": 'export { g as h } from "./one";',
  "src/barrel-use.ts": 'import { h as local } from "./two"; local("/x");',
  "src/wrapper.ts":
    'import axios from "axios"; function load() { return axios.get("/x"); } load();',
};
const span = (file: string, value: string, occurrence = 0): NativeReferenceSpan => {
  const bytes = Buffer.from(src[file]!);
  let start = 0;
  for (let i = 0; i <= occurrence; i++) {
    start = bytes.indexOf(Buffer.from(value), start);
    assert.ok(start >= 0, `${file}: ${value}`);
    if (i < occurrence) start += Buffer.byteLength(value);
  }
  return { file, start, end: start + Buffer.byteLength(value) };
};
const link = (
  kind: NativeLineageChain["links"][number]["kind"],
  file: string,
  whole: string,
  from: string,
  to: string,
  fromToken: string,
  toToken: string,
  specifier?: string,
  occurrence = 0,
): NativeLineageChain["links"][number] => {
  const all = span(file, whole, occurrence);
  const token = (value: string) => {
    const start = Buffer.from(src[file]!).indexOf(Buffer.from(value), all.start);
    assert.ok(start >= all.start && start + Buffer.byteLength(value) <= all.end);
    return { file, start, end: start + Buffer.byteLength(value) };
  };
  return {
    kind,
    from,
    to,
    span: all,
    fromSpan: token(fromToken),
    toSpan: token(toToken),
    ...(specifier ? { specifierSpan: token(specifier) } : {}),
  };
};
const read = async (s: NativeReferenceSpan): Promise<Uint8Array | null> => {
  const bytes = Buffer.from(src[s?.file] ?? "");
  return Number.isSafeInteger(s?.start) &&
    Number.isSafeInteger(s?.end) &&
    s.start >= 0 &&
    s.end > s.start &&
    s.end <= bytes.length
    ? bytes.subarray(s.start, s.end)
    : null;
};
const entry = link(
  "import",
  "src/use.ts",
  'import { get as g } from "axios"',
  "get",
  "g",
  "get",
  "g",
  '"axios"',
);
const alias = link("alias", "src/use.ts", "const a = g", "g", "a", "g", "a");
const call = link("call", "src/use.ts", 'a("/x")', "a", "a", "a", "a");
const chain = (links: NativeLineageChain["links"]): NativeLineageChain => ({ links });
describe("native lineage citation reconstruction (#458)", () => {
  it("upgrades a complete cited import, alias and call", async () => {
    assert.equal(
      (await reconstructLineage(chain([entry, alias, call]), "axios", call.span, "a", read)).status,
      "core-reconstructed",
    );
  });
  it("upgrades require and multi-barrel chains with exact relative specifiers", async () => {
    const reqEntry = link(
      "require",
      "src/req.cjs",
      'get: g } = require("axios")',
      "get",
      "g",
      "get",
      "g",
      '"axios"',
    );
    const reqCall = link("call", "src/req.cjs", 'g("/x")', "g", "g", "g", "g");
    assert.equal(
      (await reconstructLineage(chain([reqEntry, reqCall]), "axios", reqCall.span, "g", read))
        .status,
      "core-reconstructed",
    );
    const first = link(
      "re-export",
      "src/one.ts",
      'export { get as g } from "axios"',
      "get",
      "g",
      "get",
      "g",
      '"axios"',
    );
    const second = link(
      "re-export",
      "src/two.ts",
      'export { g as h } from "./one"',
      "g",
      "h",
      "g",
      "h",
      '"./one"',
    );
    const imported = link(
      "import",
      "src/barrel-use.ts",
      'import { h as local } from "./two"',
      "h",
      "local",
      "h",
      "local",
      '"./two"',
    );
    const used = link(
      "call",
      "src/barrel-use.ts",
      'local("/x")',
      "local",
      "local",
      "local",
      "local",
    );
    assert.equal(
      (
        await reconstructLineage(
          chain([first, second, imported, used]),
          "axios",
          used.span,
          "local",
          read,
        )
      ).status,
      "core-reconstructed",
    );
  });
  it("rejects a quoted package decoy outside the module source", async () => {
    const file = "src/use.ts";
    const previous = src[file];
    src[file] = 'import { get as g } from "other"; // "axios"\nconst a = g;\na("/x");';
    try {
      const forged = link(
        "import",
        file,
        'import { get as g } from "other"; // "axios"',
        "get",
        "g",
        "get",
        "g",
        '"axios"',
      );
      const a = link("alias", file, "const a = g", "g", "a", "g", "a");
      const used = link("call", file, 'a("/x")', "a", "a", "a", "a");
      assert.match(
        (await reconstructLineage(chain([forged, a, used]), "axios", used.span, "a", read)).reason!,
        /declaration source/,
      );
    } finally {
      src[file] = previous!;
    }
  });
  it("rejects falsified package, missing edge, broken chain and invalid byte offset", async () => {
    const falsified = { ...entry, specifierSpan: span("src/use.ts", '"/x"') };
    assert.equal(
      (await reconstructLineage(chain([falsified, alias, call]), "axios", call.span, "a", read))
        .status,
      "adapter-asserted",
    );
    assert.match(
      (await reconstructLineage(chain([entry, call]), "axios", call.span, "a", read)).reason!,
      /gap/,
    );
    const broken = {
      links: [entry],
      brokenAt: { span: span("src/use.ts", "a"), reason: "dynamic import" },
    };
    assert.match(
      (await reconstructLineage(broken, "axios", call.span, "a", read)).reason!,
      /dynamic import/,
    );
    const invalid = { ...alias, toSpan: { ...alias.toSpan, end: 99_999 } };
    assert.match(
      (await reconstructLineage(chain([entry, invalid, call]), "axios", call.span, "a", read))
        .reason!,
      /offsets/,
    );
  });
  it("reconstructs a single wrapper only with the internal call cited as its predecessor", async () => {
    const imp = link(
      "import",
      "src/wrapper.ts",
      'import axios from "axios"',
      "axios",
      "axios",
      "axios",
      "axios",
      '"axios"',
    );
    const inner = link(
      "call",
      "src/wrapper.ts",
      'axios.get("/x")',
      "axios",
      "get",
      "axios.get",
      "axios.get",
    );
    const outer = link("call", "src/wrapper.ts", "load()", "load", "load", "load", "load");
    const declaration = span("src/wrapper.ts", 'function load() { return axios.get("/x"); }');
    const wrap = {
      kind: "wrapper" as const,
      from: "axios.get",
      to: "load",
      span: declaration,
      fromSpan: inner.span,
      toSpan: span("src/wrapper.ts", "load"),
    };
    assert.equal(
      (
        await reconstructLineage(
          chain([imp, inner, wrap, outer]),
          "axios",
          outer.span,
          "load",
          read,
        )
      ).status,
      "core-reconstructed",
    );
  });
});
