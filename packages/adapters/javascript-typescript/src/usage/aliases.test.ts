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

  it("follows extends into a workspace package (#145): subpath, bare name, tsconfig field", async () => {
    const files = {
      "package.json": `{"name":"root","private":true}`,
      "packages/tsconfig/package.json": `{"name":"@repo/typescript-config"}`,
      "packages/tsconfig/base.json": `{"compilerOptions":{"baseUrl":".","paths":{"@ui/*":["../ui/src/*"]}}}`,
      "packages/tsconfig/tsconfig.json": `{"compilerOptions":{"paths":{"@bare/*":["../ui/src/*"]}}}`,
      "packages/fielded/package.json": `{"name":"fielded","tsconfig":"conf/main.json"}`,
      "packages/fielded/conf/main.json": `{"compilerOptions":{"paths":{"@f/*":["../../ui/src/*"]}}}`,
      "packages/ui/package.json": `{"name":"ui"}`,
      "packages/ui/src/button.ts": "",
      "apps/sub/tsconfig.json": `{"extends":"@repo/typescript-config/base.json"}`,
      "apps/noext/tsconfig.json": `{"extends":"@repo/typescript-config/base"}`,
      "apps/bare/tsconfig.json": `{"extends":"@repo/typescript-config"}`,
      "apps/field/tsconfig.json": `{"extends":"fielded"}`,
    };
    assert.equal(await internal(files, "apps/sub", "@ui/button"), true);
    assert.equal(await internal(files, "apps/noext", "@ui/button"), true);
    assert.equal(await internal(files, "apps/bare", "@bare/button"), true);
    assert.equal(await internal(files, "apps/field", "@f/button"), true);
    const r = resolver(files);
    await r.configFor("apps/sub/tsconfig.json");
    assert.deepEqual(r.limitations, []);
  });

  it("a workspace package without the named file is a limitation; node_modules bases stay silent", async () => {
    const files = {
      "packages/tsconfig/package.json": `{"name":"@repo/typescript-config"}`,
      "packages/tsconfig/other.json": "{}",
      "apps/a/tsconfig.json": `{"extends":"@repo/typescript-config/missing.json"}`,
      "apps/b/tsconfig.json": `{"extends":"@tsconfig/node20/tsconfig.json"}`,
      "apps/c/tsconfig.json": `{"extends":"@repo/typescript-config/../../apps/b/tsconfig.json"}`,
    };
    const r = resolver(files);
    for (const f of ["apps/a/tsconfig.json", "apps/b/tsconfig.json", "apps/c/tsconfig.json"])
      await r.configFor(f);
    assert.deepEqual(
      r.limitations.map((e) => [e.kind, e.file]),
      [
        ["tsconfig-extends-unresolved", "apps/a/tsconfig.json"],
        ["tsconfig-extends-unresolved", "apps/c/tsconfig.json"],
      ],
    );
  });

  it("two packages with the same name are ambiguous: not followed, a limitation", async () => {
    const files = {
      "fixtures/copy/package.json": `{"name":"@repo/typescript-config"}`,
      "fixtures/copy/base.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "packages/tsconfig/package.json": `{"name":"@repo/typescript-config"}`,
      "packages/tsconfig/base.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "apps/a/tsconfig.json": `{"extends":"@repo/typescript-config/base.json"}`,
    };
    const r = resolver(files);
    const config = await r.configFor("apps/a/tsconfig.json");
    assert.equal(config?.baseUrl, undefined);
    assert.deepEqual(
      r.limitations.map((e) => [e.kind, e.file]),
      [["tsconfig-extends-ambiguous", "apps/a/tsconfig.json"]],
    );
    assert.deepEqual([...r.packageBases], []);
  });

  it("records node_modules extends bases for the run note, never as limitations", async () => {
    const files = {
      "packages/tsconfig/package.json": `{"name":"@repo/typescript-config"}`,
      "packages/tsconfig/base.json": "{}",
      "tsconfig.base.json": "{}",
      "apps/a/tsconfig.json": `{"extends":["@tsconfig/node20/tsconfig.json","@repo/typescript-config/base.json"]}`,
      "apps/b/tsconfig.json": `{"extends":["fastify-tsconfig","../../tsconfig.base.json"]}`,
      "apps/c/tsconfig.json": `{"extends":"../../node_modules/@tsconfig/strictest/tsconfig.json"}`,
    };
    const r = resolver(files);
    for (const f of ["apps/a/tsconfig.json", "apps/b/tsconfig.json", "apps/c/tsconfig.json"])
      await r.configFor(f);
    assert.deepEqual([...r.packageBases].sort(), [
      "@tsconfig/node20",
      "@tsconfig/strictest",
      "fastify-tsconfig",
    ]);
    assert.deepEqual(r.limitations, []);
  });

  it("memoises isInternal per config and specifier (#145)", async () => {
    const files = {
      "tsconfig.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "src/a.ts": "",
    };
    const r = resolver(files);
    const config = (await r.configFor("tsconfig.json"))!;
    assert.equal(r.isInternal("src/a", config), true);
    // A later file-set change can't be seen, which proves the answer is cached.
    (r as unknown as { files: Set<string> }).files.delete("src/a.ts");
    assert.equal(r.isInternal("src/a", config), true);
    assert.equal(r.isInternal("src/b", config), false);
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
