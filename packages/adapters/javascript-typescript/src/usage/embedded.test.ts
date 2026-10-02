import assert from "node:assert/strict";
import { it } from "node:test";
import { extractScriptBlocks } from "./embedded.js";

it("scans every HTML JavaScript MIME essence but not data or parameterized types", () => {
  const types = [
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript",
  ];
  for (const type of types) {
    const code = 'import "lodash";';
    const { blocks } = extractScriptBlocks(
      "index.html",
      `<script type="${type.toUpperCase()}">${code}</script>`,
    );
    assert.equal(blocks.length, 1, type);
    assert.equal(blocks[0]?.code, code, type);
  }
  for (const type of [
    "application/json",
    "importmap",
    "text/javascript; charset=utf-8",
    "application/ecmascript;version=1",
  ]) {
    assert.equal(
      extractScriptBlocks("index.html", `<script type="${type}">import "lodash";</script>`).blocks
        .length,
      0,
      type,
    );
  }
});

it("keeps original offsets when Unicode text expands during lowercasing", () => {
  const text = [
    "<p>İİİ</p>",
    '<SCRIPT title="İ">import "lodash";</SCRIPT>',
    "<p>İ</p>",
    '<script>import "axios";</script>',
  ].join("\n");
  const { blocks } = extractScriptBlocks("index.html", text);
  assert.deepEqual(
    blocks.map(({ code, line }) => [code, line]),
    [
      ['import "lodash";', 2],
      ['import "axios";', 4],
    ],
  );
});
