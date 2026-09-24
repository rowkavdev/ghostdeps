import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRef } from "@ghostdeps/core";
import { scanDeclaredLines } from "./declared-lines.js";
import { parseManifestText } from "./manifest.js";

const SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);
const root: ProjectRef = { path: ".", ecosystem: "javascript-typescript", packageManagers: [] };

describe("scanDeclaredLines (#198 slice B)", () => {
  it("records the line of each key inside dependency sections", () => {
    const text = [
      "{",
      '  "name": "demo",',
      '  "dependencies": {',
      '    "chalk": "^5.0.0",',
      '    "@scope/pkg": "1.0.0"',
      "  },",
      '  "devDependencies": { "vitest": "^1" }',
      "}",
    ].join("\n");
    const lines = scanDeclaredLines(text, SECTIONS);
    assert.equal(lines.get("dependencies")?.get("chalk"), 4);
    assert.equal(lines.get("dependencies")?.get("@scope/pkg"), 5);
    assert.equal(lines.get("devDependencies")?.get("vitest"), 7);
  });

  it("ignores same-named keys outside dependency sections and in nested values", () => {
    const text = [
      "{",
      '  "scripts": { "chalk": "echo chalk" },',
      '  "overrides": { "dependencies": { "chalk": "1" } },',
      '  "dependencies": {',
      '    "chalk": "^5.0.0"',
      "  }",
      "}",
    ].join("\n");
    const lines = scanDeclaredLines(text, SECTIONS);
    assert.equal(lines.get("dependencies")?.get("chalk"), 5);
    assert.equal(lines.size, 1);
  });

  it("handles escapes, braces inside strings, CRLF and duplicate keys like JSON.parse", () => {
    const text = [
      "{",
      '  "description": "a { tricky \\" } value\\n",',
      '  "dependencies": {',
      '    "left-pad": "1.0.0",',
      '    "left-pad": "1.3.0",',
      '    "\\u0061xios": "1"',
      "  }",
      "}",
    ].join("\r\n");
    const lines = scanDeclaredLines(text, SECTIONS);
    assert.equal(lines.get("dependencies")?.get("left-pad"), 5);
    assert.equal(lines.get("dependencies")?.get("axios"), 6);
  });
});

describe("parseManifestText declaredLine", () => {
  it("fills declaredLine for every parsed dependency", () => {
    const text =
      '{\n  "dependencies": {\n    "chalk": "^5"\n  },\n  "peerDependencies": {\n    "react": ">=18"\n  }\n}\n';
    const { dependencies } = parseManifestText(text, root, "package.json");
    assert.deepEqual(
      dependencies.map((d) => [d.name, d.declaredLine]),
      [
        ["chalk", 3],
        ["react", 6],
      ],
    );
  });

  it("puts a single-line manifest on line 1", () => {
    const { dependencies } = parseManifestText('{"dependencies":{"a":"1"}}', root, "package.json");
    assert.equal(dependencies[0]?.declaredLine, 1);
  });
});
