import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeTerminal } from "./escape.js";

describe("escapeTerminal", () => {
  it("leaves ordinary text alone", () => {
    assert.equal(escapeTerminal("pnpm"), "pnpm");
    assert.equal(escapeTerminal("JavaScript/TypeScript"), "JavaScript/TypeScript");
  });

  it("replaces ESC and BEL (OSC 8 hyperlink attempt)", () => {
    assert.equal(
      escapeTerminal("pm\u001B[8;;https://evil.example\u0007name"),
      "pm\uFFFD[8;;https://evil.example\uFFFDname",
    );
  });

  it("replaces C1 controls", () => {
    assert.equal(escapeTerminal("a\u0085b"), "a\uFFFDb");
  });

  it("replaces bidi override characters", () => {
    assert.equal(escapeTerminal("\u202Etnp\u202Cp"), "\uFFFDtnp\uFFFDp");
  });

  it("replaces zero-width characters", () => {
    assert.equal(escapeTerminal("pn\u200Bpm"), "pn\uFFFDpm");
  });

  it("keeps newlines out of single-line fields by replacing them", () => {
    assert.equal(escapeTerminal("a\nb"), "a\uFFFDb");
  });

  it("replaces invisible format characters", () => {
    for (const ch of [
      "\u00AD",
      "\u180E",
      "\u2028",
      "\u2029",
      "\u2060",
      "\u2061",
      "\u2064",
      "\u206A",
      "\u{E0041}",
    ]) {
      assert.equal(escapeTerminal(`a${ch}b`), "a\uFFFDb", JSON.stringify(ch));
    }
  });

  it("does not touch visible non-ASCII text", () => {
    assert.equal(escapeTerminal("pkg-é-日本-😀"), "pkg-é-日本-😀");
  });

  it("accepts that tag-block escaping breaks subdivision-flag emoji", () => {
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    assert.equal(escapeTerminal(england), "\u{1F3F4}\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD");
  });
});
