import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseName, parseRequirement } from "./pep508.js";

describe("normaliseName (PEP 503)", () => {
  it("lowercases and collapses separators", () => {
    assert.equal(normaliseName("Foo.Bar__baz-Qux"), "foo-bar-baz-qux");
    assert.equal(normaliseName("PyYAML"), "pyyaml");
  });
});

describe("parseRequirement (PEP 508)", () => {
  it("parses name, extras, specifier and marker", () => {
    assert.deepEqual(
      parseRequirement('Requests[Socks, security] >= 2.8.1, <3 ; python_version < "3.12"'),
      {
        rawName: "Requests",
        name: "requests",
        extras: ["socks", "security"],
        specifier: ">=2.8.1,<3",
        marker: 'python_version < "3.12"',
      },
    );
  });

  it("parses a bare name as unconstrained", () => {
    assert.deepEqual(parseRequirement("click"), {
      rawName: "click",
      name: "click",
      extras: [],
      specifier: "",
    });
  });

  it("accepts parenthesised specifiers", () => {
    assert.equal(parseRequirement("attrs (>=22)")?.specifier, ">=22");
  });

  it("records direct references without fetching", () => {
    const req = parseRequirement("pkg @ git+https://example.com/pkg.git@v1");
    assert.equal(req?.url, "git+https://example.com/pkg.git@v1");
    assert.equal(req?.specifier, "");
  });

  it("rejects garbage", () => {
    for (const bad of ["", "   ", "-e .", "pkg[unclosed", "pkg is great", "pkg @ "]) {
      assert.equal(parseRequirement(bad), undefined, bad);
    }
  });
});
