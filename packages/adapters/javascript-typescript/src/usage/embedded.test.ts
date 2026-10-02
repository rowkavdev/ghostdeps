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

it("does not end script opening tags at greater-than signs inside quoted attributes", () => {
  for (const quote of ['"', "'"]) {
    const text = `<script data-note=${quote}>${quote} lang="ts">import "lodash";</script>`;
    assert.deepEqual(
      extractScriptBlocks("index.html", text).blocks.map(({ code }) => code),
      ['import "lodash";'],
    );
    const data = `<script data-note=${quote}>${quote} type="application/json">{"x":1}</script>`;
    assert.deepEqual(extractScriptBlocks("index.html", data).blocks, []);
  }
  assert.deepEqual(
    extractScriptBlocks("index.html", "<script title=\"unterminated > import 'lodash';").blocks,
    [],
  );
});

it("does not treat quotes within unquoted attribute values as delimiters", () => {
  const text = `<script data-x=it's>import "lodash";</script><script title = '>'>import "axios";</script>`;
  assert.deepEqual(
    extractScriptBlocks("index.html", text).blocks.map(({ code }) => code),
    ['import "lodash";', 'import "axios";'],
  );
});
