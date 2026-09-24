import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseName } from "./pep508.js";
import {
  ImportResolver,
  KNOWN_IMPORT_NAMES,
  distributionFromMetadataPath,
  parseTopLevel,
  topLevelModule,
} from "./import-map.js";
import { STDLIB_MODULES } from "./stdlib.js";

describe("KNOWN_IMPORT_NAMES data", () => {
  it("stores only PEP 503-normalised distribution names", () => {
    for (const [module, dists] of Object.entries(KNOWN_IMPORT_NAMES)) {
      assert.ok(dists.length > 0, module);
      for (const dist of dists) assert.equal(dist, normaliseName(dist), `${module} -> ${dist}`);
    }
  });

  it("never maps a standard-library module", () => {
    for (const module of Object.keys(KNOWN_IMPORT_NAMES)) {
      assert.ok(!STDLIB_MODULES.has(module), module);
    }
  });

  it("keys are valid top-level identifiers", () => {
    for (const module of Object.keys(KNOWN_IMPORT_NAMES)) {
      assert.match(module, /^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});

describe("ImportResolver", () => {
  const resolver = new ImportResolver({
    declared: [
      "Pillow",
      "PyYAML",
      "requests",
      "scikit-learn",
      "typing_extensions",
      "psycopg2-binary",
    ],
    firstParty: ["myapp"],
  });

  it("maps known mismatches through the table", () => {
    assert.deepEqual(resolver.resolve("PIL.Image"), {
      kind: "dependency",
      module: "PIL",
      distribution: "pillow",
      via: "table",
    });
    assert.equal(resolver.resolve("yaml").kind, "dependency");
    assert.equal(
      (resolver.resolve("sklearn.linear_model") as { distribution: string }).distribution,
      "scikit-learn",
    );
  });

  it("prefers the alternative the project declares", () => {
    const r = resolver.resolve("psycopg2");
    assert.deepEqual(r, {
      kind: "dependency",
      module: "psycopg2",
      distribution: "psycopg2-binary",
      via: "table",
    });
  });

  it("falls back to the normalised-name rule", () => {
    assert.deepEqual(resolver.resolve("requests.adapters"), {
      kind: "dependency",
      module: "requests",
      distribution: "requests",
      via: "name",
    });
    assert.equal(
      (resolver.resolve("typing_extensions") as { distribution: string }).distribution,
      "typing-extensions",
    );
  });

  it("classifies stdlib and first-party imports", () => {
    assert.deepEqual(resolver.resolve("os.path"), { kind: "stdlib", module: "os" });
    assert.deepEqual(resolver.resolve("tomllib"), { kind: "stdlib", module: "tomllib" });
    assert.deepEqual(resolver.resolve("__future__"), { kind: "stdlib", module: "__future__" });
    assert.deepEqual(resolver.resolve("myapp.models"), { kind: "first-party", module: "myapp" });
  });

  it("reports unknown imports as unresolved instead of guessing", () => {
    assert.deepEqual(resolver.resolve("mystery_lib"), {
      kind: "unresolved",
      module: "mystery_lib",
      candidates: [],
    });
  });

  it("does not attribute a known mapping whose distribution is undeclared", () => {
    assert.deepEqual(resolver.resolve("cv2"), {
      kind: "unresolved",
      module: "cv2",
      candidates: ["opencv-python", "opencv-python-headless", "opencv-contrib-python"],
    });
  });

  it("uses committed top_level.txt metadata before the table", () => {
    const withMeta = new ImportResolver({
      declared: ["weird-dist", "pyyaml"],
      topLevel: new Map([
        ["Weird_Dist", ["oddmodule"]],
        ["other-undeclared", ["yaml"]],
      ]),
    });
    assert.deepEqual(withMeta.resolve("oddmodule.sub"), {
      kind: "dependency",
      module: "oddmodule",
      distribution: "weird-dist",
      via: "metadata",
    });
    // Metadata for an undeclared dist does not shadow a declared table match.
    assert.equal((withMeta.resolve("yaml") as { via: string }).via, "table");
  });

  it("lists the import names a distribution can appear under", () => {
    assert.deepEqual(resolver.importNamesFor("Pillow"), ["PIL", "pillow"]);
    assert.deepEqual(resolver.importNamesFor("typing-extensions"), ["typing_extensions"]);
    assert.deepEqual(resolver.importNamesFor("pywin32"), ["pywin32", "win32api", "win32con"]);
  });
});

describe("metadata helpers", () => {
  it("topLevelModule takes the first dotted segment", () => {
    assert.equal(topLevelModule("google.protobuf.message"), "google");
    assert.equal(topLevelModule("six"), "six");
  });

  it("parseTopLevel keeps identifier lines only", () => {
    assert.deepEqual(parseTopLevel("yaml\r\n_yaml\n\n  # c\nbad-name\n"), ["yaml", "_yaml"]);
  });

  it("distributionFromMetadataPath reads dist-info and egg-info names", () => {
    assert.equal(
      distributionFromMetadataPath("vendor/PyYAML-6.0.1.dist-info/top_level.txt"),
      "pyyaml",
    );
    assert.equal(distributionFromMetadataPath("src/my_pkg.egg-info/top_level.txt"), "my-pkg");
    assert.equal(
      distributionFromMetadataPath("src/zope.interface-6.0.dist-info/top_level.txt"),
      "zope-interface",
    );
    assert.equal(distributionFromMetadataPath("top_level.txt"), undefined);
  });
});
