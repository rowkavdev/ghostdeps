import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PR_SOURCE_CHANGE_LIMITS } from "../limits.js";
import type { SourceLineChanges } from "../types/index.js";
import { boundSourceChanges } from "./source-changes.js";

const line = (n: number, text = `import x${n} from "x";`) => ({ line: n, text });
const file = (path: string, removed = [line(1)], added: SourceLineChanges["addedLines"] = []) => ({
  path,
  removedLines: removed,
  addedLines: added,
});

describe("boundSourceChanges (#101)", () => {
  it("passes a small payload through unchanged with no note", () => {
    const input = [file("src/a.ts"), file("src/b.ts", [], [line(3)])];
    assert.deepEqual(boundSourceChanges(input), { changes: input, findings: [] });
  });

  it("caps lines per file and says so in one info finding", () => {
    const limits = { ...PR_SOURCE_CHANGE_LIMITS, maxLinesPerFile: 2 };
    const out = boundSourceChanges([file("src/a.ts", [line(1), line(2), line(3)])], limits);
    assert.deepEqual(
      out.changes[0]?.removedLines.map((l) => l.line),
      [1, 2],
    );
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0]?.kind, "info");
    assert.equal(out.findings[0]?.rule, "pr-source-changes-capped");
    assert.match(out.findings[0]?.summary ?? "", /0 file\(s\) and 1 line\(s\)/);
  });

  it("drops over-long lines instead of cutting them", () => {
    const limits = { ...PR_SOURCE_CHANGE_LIMITS, maxLineChars: 10 };
    const out = boundSourceChanges(
      [file("src/a.ts", [line(1, "short"), line(2, "x".repeat(11))])],
      limits,
    );
    assert.deepEqual(out.changes[0]?.removedLines, [{ line: 1, text: "short" }]);
    assert.equal(out.findings.length, 1);
  });

  it("stops at the total character budget", () => {
    const limits = { ...PR_SOURCE_CHANGE_LIMITS, maxTotalChars: 30 };
    const out = boundSourceChanges(
      [file("a.ts", [line(1, "x".repeat(20))]), file("b.ts", [line(1, "y".repeat(20))])],
      limits,
    );
    assert.equal(out.changes[0]?.removedLines.length, 1);
    assert.equal(out.changes[1]?.removedLines.length ?? 0, 0);
    assert.equal(out.findings.length, 1);
  });

  it("drops unsafe paths and malformed entries", () => {
    const hostile = [
      file("../etc/passwd"),
      file("/abs.ts"),
      { path: 7 },
      file("src/ok.ts", [
        { line: 0, text: "bad line number" },
        { line: 2, text: 5 },
        line(3),
      ] as never),
    ] as unknown as SourceLineChanges[];
    const out = boundSourceChanges(hostile);
    assert.deepEqual(
      out.changes.map((c) => [c.path, c.removedLines.map((l) => l.line)]),
      [["src/ok.ts", [3]]],
    );
    assert.match(out.findings[0]?.summary ?? "", /3 file\(s\) and 2 line\(s\)/);
  });
});
