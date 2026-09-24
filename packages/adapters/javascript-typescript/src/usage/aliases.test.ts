import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryHandle } from "../testing/fs-handle.js";
import { AliasResolver, MAX_CONFIG_BYTES, joinPath } from "./aliases.js";

const resolver = (files: Record<string, string>) =>
  new AliasResolver(memoryHandle(files), Object.keys(files));

async function internal(files: Record<string, string>, fromDir: string, spec: string) {
  const r = resolver(files);
  const configFile = r.nearestConfig(fromDir);
  assert.ok(configFile, "expected a config");
  const config = await r.configFor(configFile);
  assert.ok(config);
  return r.isInternal(spec, config);
}

describe("joinPath", () => {
  it("normalises and refuses to escape the root", () => {
    assert.equal(joinPath("a/b", "../c/./d"), "a/c/d");
    assert.equal(joinPath(".", "./src"), "src");
    assert.equal(joinPath("a", "../.."), undefined);
  });
});

describe("AliasResolver", () => {
  const base = {
    "tsconfig.json": `{
      // comments and trailing commas are fine
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@app/*": ["src/*"], "utils": ["src/utils/index.ts"], },
      },
    }`,
    "src/db/client.ts": "",
    "src/utils/index.ts": "",
    "src/lib/log.ts": "",
  };

  it("wildcard and exact paths entries resolving to repo files are internal", async () => {
    assert.equal(await internal(base, "src", "@app/db/client"), true);
    assert.equal(await internal(base, "src", "utils"), true);
  });

  it("baseUrl-relative bare specifiers resolving to repo files are internal", async () => {
    assert.equal(await internal(base, "src", "src/lib/log"), true);
  });

  it("an alias whose target does not exist does not hide package usage", async () => {
    assert.equal(await internal(base, "src", "@app/missing"), false);
    assert.equal(await internal(base, "src", "lodash"), false);
  });

  it("a catch-all node_modules fallback never marks packages internal", async () => {
    const files = {
      "tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"*":["types/*","node_modules/*"]}}}`,
      "types/legacy.d.ts": "",
      "node_modules/react/index.js": "",
    };
    assert.equal(await internal(files, ".", "react"), false);
    assert.equal(await internal(files, ".", "legacy"), true);
  });

  it("paths without baseUrl resolve relative to the config that defines them", async () => {
    const files = {
      "packages/web/tsconfig.json": `{"compilerOptions":{"paths":{"~ui/*":["./ui/*"]}}}`,
      "packages/web/ui/button.tsx": "",
    };
    assert.equal(await internal(files, "packages/web/src", "~ui/button"), true);
  });

  it("follows relative extends (with or without .json); nearest config wins", async () => {
    const files = {
      "tsconfig.base.json": `{"compilerOptions":{"baseUrl":".","paths":{"@shared/*":["shared/*"]}}}`,
      "shared/x.ts": "",
      "apps/a/tsconfig.json": `{"extends":"../../tsconfig.base","compilerOptions":{}}`,
      "apps/b/tsconfig.json": `{"extends":["@tsconfig/node20/tsconfig.json","../../tsconfig.base.json"],"compilerOptions":{"paths":{"@b/*":["./src/*"]}}}`,
      "apps/b/src/y.ts": "",
    };
    assert.equal(await internal(files, "apps/a", "@shared/x"), true);
    // b's own paths replace the base's (TS semantics), and resolve against the base's baseUrl.
    assert.equal(await internal(files, "apps/b", "@shared/x"), false);
    assert.equal(await internal(files, "apps/b", "@b/y"), false);
    assert.equal(await internal(files, "apps/b", "apps/b/src/y"), true);
  });

  it("extends cycles and oversize or malformed configs become limitations, never throws", async () => {
    const files = {
      "a/tsconfig.json": `{"extends":"../b/tsconfig.json"}`,
      "b/tsconfig.json": `{"extends":"../a/tsconfig.json"}`,
      "big/tsconfig.json": " ".repeat(MAX_CONFIG_BYTES + 1),
      "bad/tsconfig.json": `{"compilerOptions": `,
    };
    const r = resolver(files);
    for (const f of ["a/tsconfig.json", "big/tsconfig.json", "bad/tsconfig.json"]) {
      await r.configFor(f);
    }
    const kinds = r.limitations.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ["tsconfig-extends-cycle", "tsconfig-malformed", "tsconfig-too-large"]);
  });

  it("uses own keys only: prototype-named keys never match or pollute", async () => {
    const files = {
      "tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"__proto__":{"polluted":true},"constructor":["nope/*"]}}}`,
      "src/p.ts": "",
    };
    assert.equal(await internal(files, ".", "constructor"), false);
    assert.equal(await internal(files, ".", "toString"), false);
    assert.equal(await internal(files, ".", "__proto__"), false);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("jsconfig.json is honoured and nearestConfig stops at the project root", () => {
    const r = resolver({ "jsconfig.json": "{}", "pkg/src/a.js": "" });
    assert.equal(r.nearestConfig("pkg/src"), "jsconfig.json");
    assert.equal(r.nearestConfig("pkg/src", "pkg"), undefined);
  });
});
