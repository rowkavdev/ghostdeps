import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseName } from "./pep508.js";
import {
  ImportResolver,
  KNOWN_IMPORT_NAMES,
  NAMESPACE_ROOTS,
  distributionFromMetadataPath,
  parseTopLevel,
  readTopLevelMetadata,
  topLevelModule,
} from "./import-map.js";
import { memoryHandle } from "./testing/fs-handle.js";
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

  it("keys are identifiers, dotted only under a namespace root", () => {
    for (const module of Object.keys(KNOWN_IMPORT_NAMES)) {
      assert.match(module, /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/);
      if (module.includes(".")) assert.ok(NAMESPACE_ROOTS.has(module.split(".")[0]!), module);
      else assert.ok(!NAMESPACE_ROOTS.has(module), `bare namespace root ${module}`);
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
      distributions: ["pillow"],
      via: "table",
    });
    assert.equal(resolver.resolve("yaml").kind, "dependency");
    assert.deepEqual(
      (resolver.resolve("sklearn.linear_model") as { distributions: string[] }).distributions,
      ["scikit-learn"],
    );
  });

  it("prefers the alternative the project declares", () => {
    const r = resolver.resolve("psycopg2");
    assert.deepEqual(r, {
      kind: "dependency",
      module: "psycopg2",
      distributions: ["psycopg2-binary"],
      via: "table",
    });
  });

  it("falls back to the normalised-name rule", () => {
    assert.deepEqual(resolver.resolve("requests.adapters"), {
      kind: "dependency",
      module: "requests",
      distributions: ["requests"],
      via: "name",
    });
    assert.deepEqual(
      (resolver.resolve("typing_extensions") as { distributions: string[] }).distributions,
      ["typing-extensions"],
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
      distributions: ["weird-dist"],
      via: "metadata",
    });
    // Metadata for an undeclared dist does not shadow a declared table match.
    assert.equal((withMeta.resolve("yaml") as { via: string }).via, "table");
  });

  it("resolves namespace packages on the longest dotted table key", () => {
    const ns = new ImportResolver({
      declared: ["protobuf", "google-cloud-storage", "google-api-python-client"],
    });
    assert.deepEqual(ns.resolve("google.cloud.storage.blob"), {
      kind: "dependency",
      module: "google.cloud.storage",
      distributions: ["google-cloud-storage"],
      via: "table",
    });
    assert.deepEqual(
      (ns.resolve("google.protobuf.message") as { distributions: string[] }).distributions,
      ["protobuf"],
    );
    assert.deepEqual(
      (ns.resolve("googleapiclient.discovery") as { distributions: string[] }).distributions,
      ["google-api-python-client"],
    );
    // A bare namespace root, or an unknown child, is never credited.
    assert.equal(ns.resolve("google").kind, "unresolved");
    assert.equal(ns.resolve("google.cloud.unknownsvc").kind, "unresolved");
  });

  it("does not credit a namespace root through metadata or the name rule", () => {
    const ns = new ImportResolver({
      declared: ["google", "google-cloud-storage"],
      topLevel: new Map([["google-cloud-storage", ["google"]]]),
    });
    assert.equal(ns.resolve("google.something").kind, "unresolved");
    assert.deepEqual(
      (ns.resolve("google.cloud.storage") as { distributions: string[] }).distributions,
      ["google-cloud-storage"],
    );
  });

  it("credits every declared alternative instead of picking one", () => {
    const both = new ImportResolver({ declared: ["opencv-python", "opencv-python-headless"] });
    assert.deepEqual(both.resolve("cv2"), {
      kind: "dependency",
      module: "cv2",
      distributions: ["opencv-python", "opencv-python-headless"],
      via: "table",
    });
    const meta = new ImportResolver({
      declared: ["dist-a", "dist-b"],
      topLevel: new Map([
        ["dist-b", ["shared"]],
        ["dist-a", ["shared"]],
      ]),
    });
    assert.deepEqual((meta.resolve("shared") as { distributions: string[] }).distributions, [
      "dist-a",
      "dist-b",
    ]);
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

  it("readTopLevelMetadata skips excluded dirs and oversized files", async () => {
    const meta = await readTopLevelMetadata(
      memoryHandle({
        "libs/Good-1.0.dist-info/top_level.txt": "good\n",
        ".venv/lib/site-packages/Bad-1.0.dist-info/top_level.txt": "bad\n",
        "vendor/Vend-1.0.dist-info/top_level.txt": "vend\n",
        "libs/Huge-1.0.dist-info/top_level.txt": "x\n".repeat(40_000),
      }),
      ".",
    );
    assert.deepEqual([...meta.keys()], ["good"]);
  });
});
