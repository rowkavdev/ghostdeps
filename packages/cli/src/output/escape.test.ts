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
});
