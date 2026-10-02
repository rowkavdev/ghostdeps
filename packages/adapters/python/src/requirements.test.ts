import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRef } from "@ghostdeps/core";
import { parseManifests } from "./manifest.js";
import {
  MAX_INCLUDE_DEPTH,
  MAX_REQUIREMENTS_BYTES,
  parseRequirementsFiles,
  requirementsEntryPoints,
  requirementsKind,
  resolveInclude,
} from "./requirements.js";
import { memoryHandle } from "./testing/fs-handle.js";

const project: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };

async function parse(files: Record<string, string>, entries = ["requirements.txt"]) {
  return parseRequirementsFiles(memoryHandle(files), project, entries);
}
const names = (result: Awaited<ReturnType<typeof parse>>) =>
  result.requirements.map(
    (r) =>
      `${r.dependency.name} ${r.dependency.constraint} ${r.dependency.kind} ${r.dependency.declaredIn}`,
  );

describe("parseRequirementsFiles (issue #44)", () => {
  it("reads pins, ranges, extras, markers, comments and hashes", async () => {
    const result = await parse({
      "requirements.txt": [
        "# comment",
        "Django==5.0.1  # pinned",
        "requests[socks]>=2.31,<3",
        'tomli>=2 ; python_version < "3.11"',
        "cryptography==42.0.0 \\",
        "    --hash=sha256:aaa \\",
        "    --hash=sha256:bbb",
        "--index-url https://example.com/simple",
        "--pre",
        "",
      ].join("\n"),
    });
    assert.deepEqual(names(result), [
      "django ==5.0.1 runtime requirements.txt",
      "requests >=2.31,<3 runtime requirements.txt",
      "tomli >=2 runtime requirements.txt",
      "cryptography ==42.0.0 runtime requirements.txt",
    ]);
    assert.deepEqual(result.requirements[1]?.extras, ["socks"]);
    assert.equal(result.requirements[2]?.marker, 'python_version < "3.11"');
  });

  it("resolves -r includes relative to the including file", async () => {
    const result = await parse(
      {
        "requirements/dev.txt": "-r base.txt\npytest\n",
        "requirements/base.txt": "flask\n",
      },
      ["requirements/dev.txt"],
    );
    assert.deepEqual(names(result), [
      "flask * dev requirements/base.txt",
      "pytest * dev requirements/dev.txt",
    ]);
  });

  it("reads a shared base as runtime when it is also an entry point", async () => {
    const result = await parse(
      { "requirements.txt": "flask\n", "requirements-dev.txt": "-r requirements.txt\npytest\n" },
      ["requirements.txt", "requirements-dev.txt"],
    );
    assert.deepEqual(names(result), [
      "flask * runtime requirements.txt",
      "pytest * dev requirements-dev.txt",
    ]);
  });

  it("emits one Dependency per name and kind across files", async () => {
    const result = await parse(
      { "requirements.txt": "flask\n", "requirements/prod.txt": "flask>=3\ngunicorn\n" },
      ["requirements.txt", "requirements/prod.txt"],
    );
    assert.deepEqual(names(result), [
      "flask >=3 runtime requirements.txt",
      "gunicorn * runtime requirements/prod.txt",
    ]);
  });

  it("keeps the shared base runtime when the dev file sorts first and includes it (#241 review)", async () => {
    // Entry points come back sorted: requirements-dev.txt before requirements.txt.
    const files = {
      "requirements.txt": "flask\n",
      "requirements-dev.txt": "-r requirements.txt\npytest\n",
      "app.py": "",
    };
    const { entries } = requirementsEntryPoints(project, Object.keys(files).sort());
    assert.deepEqual(entries, ["requirements-dev.txt", "requirements.txt"]);
    const result = await parseManifests(memoryHandle(files), project);
    assert.deepEqual(
      result.requirements.map(
        (r) => `${r.dependency.name} ${r.dependency.kind} ${r.dependency.declaredIn}`,
      ),
      ["flask runtime requirements.txt", "pytest dev requirements-dev.txt"],
    );
  });

  it("keeps requirements/base.txt runtime when requirements/dev.txt includes it", async () => {
    const files = {
      "requirements/base.txt": "flask\n",
      "requirements/dev.txt": "-r base.txt\npytest\n",
      "app.py": "",
    };
    const result = await parseManifests(memoryHandle(files), project);
    assert.deepEqual(
      result.requirements.map(
        (r) => `${r.dependency.name} ${r.dependency.kind} ${r.dependency.declaredIn}`,
      ),
      ["flask runtime requirements/base.txt", "pytest dev requirements/dev.txt"],
    );
  });

  it("strips per-requirement options only after the requirement", async () => {
    const result = await parse({
      "requirements.txt":
        'pkg==1.0 ; python_version >= "3.9" --hash=sha256:abc --hash=sha256:def\n',
    });
    assert.equal(result.requirements[0]?.dependency.constraint, "==1.0");
    assert.equal(result.requirements[0]?.marker, 'python_version >= "3.9"');
  });

  it("does not parse an oversized requirements file", async () => {
    const result = await parse({
      "requirements.txt": `flask\n# ${"x".repeat(MAX_REQUIREMENTS_BYTES)}\n`,
    });
    assert.deepEqual(result.requirements, []);
    assert.equal(result.evidence[0]?.kind, "requirements-oversized");
  });

  it("treats -c constraint files as pins, not declarations", async () => {
    const result = await parse({
      "requirements.txt": "-c constraints.txt\nflask\n",
      "constraints.txt": "werkzeug==3.0\n",
    });
    assert.deepEqual(names(result), ["flask * runtime requirements.txt"]);
  });

  it("never follows includes outside the repository or remote", async () => {
    const result = await parse({
      "requirements.txt": "-r ../../etc/passwd\n-r https://example.com/r.txt\n-r /abs.txt\n",
    });
    assert.equal(result.requirements.length, 0);
    assert.equal(
      result.evidence.filter((e) => e.kind === "requirements-include-skipped").length,
      3,
    );
  });

  it("survives include cycles and caps include depth", async () => {
    const cyc = await parse({
      "requirements.txt": "-r b.txt\na\n",
      "b.txt": "-r requirements.txt\nb\n",
    });
    assert.deepEqual(
      names(cyc)
        .map((n) => n.split(" ")[0])
        .sort(),
      ["a", "b"],
    );

    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_INCLUDE_DEPTH + 2; i++)
      files[i === 0 ? "requirements.txt" : `r${i}.txt`] = `-r r${i + 1}.txt\np${i}\n`;
    const deep = await parse(files);
    assert.ok(deep.evidence.some((e) => e.kind === "requirements-limit"));
  });

  it("notes missing includes", async () => {
    const result = await parse({ "requirements.txt": "-r nope.txt\n" });
    assert.equal(result.evidence[0]?.kind, "requirements-include-missing");
  });

  it("names editable and VCS requirements from #egg, and reports nameless ones", async () => {
    const result = await parse({
      "requirements.txt": [
        "-e git+https://example.com/lib.git@v1#egg=my_lib",
        "git+https://example.com/other.git",
        "-e .",
        "./local-pkg",
        "https://example.com/pkg-1.0.tar.gz#egg=pkg",
      ].join("\n"),
    });
    assert.deepEqual(
      result.requirements.map((r) => [r.dependency.name, r.dependency.specifier?.type]),
      [
        ["my-lib", "git"],
        ["pkg", "registry"],
      ],
    );
    assert.equal(result.evidence.filter((e) => e.kind === "requirement-unresolved").length, 3);
  });

  it("reports unparsable lines", async () => {
    const result = await parse({ "requirements.txt": "this is not valid\n" });
    assert.equal(result.evidence[0]?.kind, "requirement-unparsed");
  });
});

describe("requirements helpers", () => {
  it("classifies dev-flavoured files", () => {
    assert.equal(requirementsKind("requirements.txt"), "runtime");
    assert.equal(requirementsKind("requirements-dev.txt"), "dev");
    assert.equal(requirementsKind("test-requirements.txt"), "dev");
    assert.equal(requirementsKind("requirements/docs.txt"), "dev");
    assert.equal(requirementsKind("requirements/prod.txt"), "runtime");
  });

  it("resolves includes inside the repository only", () => {
    assert.equal(resolveInclude("a/b/requirements.txt", "../c.txt"), "a/c.txt");
    assert.equal(resolveInclude("requirements.txt", "../x.txt"), undefined);
    assert.equal(resolveInclude("r.txt", "C:\\x.txt"), undefined);
  });

  it("prefers pip-tools .in sources over compiled .txt output", () => {
    const { entries, evidence } = requirementsEntryPoints(project, [
      "requirements.in",
      "requirements.txt",
      "requirements/dev.txt",
      "docs/requirements.txt",
    ]);
    assert.deepEqual(entries, ["requirements.in", "requirements/dev.txt"]);
    assert.equal(evidence[0]?.kind, "requirements-compiled");
  });
});

describe("include spellings and modes (#576, #577)", () => {
  it("follows -r and -c with the value attached (#576)", async () => {
    const result = await parse({
      "requirements.txt": "-rbase.txt\n-cpins.txt\nflask\n",
      "base.txt": "django\n",
      "pins.txt": "werkzeug==3.0\n",
    });
    assert.deepEqual(result.requirements.map((r) => r.dependency.name).sort(), ["django", "flask"]);
    assert.deepEqual(result.evidence, []);
  });

  it("declares a file included with -c and then -r (#577)", async () => {
    const result = await parse({
      "requirements.txt": "-c base.txt\n-r base.txt\n",
      "base.txt": "django\n",
    });
    assert.deepEqual(
      result.requirements.map((r) => r.dependency.name),
      ["django"],
    );
  });

  it("still ignores a file that is only ever a constraints file", async () => {
    const result = await parse({
      "requirements.txt": "-c base.txt\n-c base.txt\nflask\n",
      "base.txt": "django\n",
    });
    assert.deepEqual(
      result.requirements.map((r) => r.dependency.name),
      ["flask"],
    );
  });
});

it("reads attached editable short-option values like pip", async () => {
  for (const option of ["-e", "-e ", "--editable="]) {
    const result = await parse({
      "requirements.txt": `${option}git+https://example.com/pkg.git#egg=demo\n`,
    });
    assert.equal(result.requirements[0]?.dependency.name, "demo", option);
    assert.equal(result.requirements[0]?.dependency.specifier?.type, "git", option);
  }
});

it("splits standalone CR newlines in requirements and local includes", async () => {
  const lines = ["# comment", "requests==2", "-r extra.txt", "numpy==1"];
  const expected = await parse({
    "requirements.txt": lines.join("\n"),
    "extra.txt": "PyYAML>=6\nhttpx\n",
  });
  for (const newline of ["\r", "\r\n"]) {
    const actual = await parse({
      "requirements.txt": lines.join(newline),
      "extra.txt": ["PyYAML>=6", "httpx", ""].join(newline),
    });
    assert.deepEqual(actual, expected);
  }
});

it("joins requirements continuations before stripping inline comments like pip", async () => {
  const slash = String.fromCharCode(92);
  const result = await parse({
    "requirements.txt": [
      `requests # note ${slash}`,
      "numpy",
      "httpx",
      `# whole comment ${slash}`,
      "PyYAML",
    ].join("\n"),
  });
  assert.deepEqual(
    result.requirements.map(({ dependency }) => [dependency.name, dependency.declaredLine]),
    [
      ["requests", 1],
      ["httpx", 3],
      ["pyyaml", 5],
    ],
  );
});

it("joins requirements continuation text without inserting extra spaces", async () => {
  const slash = String.fromCharCode(92);
  const result = await parse({
    "requirements.txt": [
      `req${slash}`,
      "uests==2",
      `PyYAML>${slash}`,
      "=6",
      `httpx==1 ${slash}`,
      " --hash=sha256:abc",
    ].join("\n"),
  });
  assert.deepEqual(
    result.requirements.map(({ dependency }) => [dependency.name, dependency.constraint]),
    [
      ["requests", "==2"],
      ["pyyaml", ">=6"],
      ["httpx", "==1"],
    ],
  );
  assert.equal(result.requirements[0]?.dependency.declaredLine, undefined);
});

it("preserves comment boundaries after continuations without preceding spaces", async () => {
  const slash = String.fromCharCode(92);
  for (const comment of ["# note", `# note ${slash}`, "  # note"]) {
    const result = await parse({
      "requirements.txt": [`requests==2${slash}`, comment, `httpx${slash}`, comment, "numpy"].join(
        "\n",
      ),
    });
    assert.deepEqual(
      result.requirements.map(({ dependency }) => [
        dependency.name,
        dependency.constraint,
        dependency.declaredLine,
      ]),
      [
        ["requests", "==2", 1],
        ["httpx", "*", 3],
        ["numpy", "*", 5],
      ],
      comment,
    );
  }
});

it("follows quoted requirements include filenames with spaces", async () => {
  for (const quote of ['"', "'"]) {
    for (const flag of ["-r", "--requirement", "--requirement="]) {
      const result = await parse({
        "requirements.txt": `${flag}${flag.endsWith("=") ? "" : " "}${quote}base file.txt${quote}\n`,
        "base file.txt": "requests>=2\n",
      });
      assert.deepEqual(names(result), ["requests >=2 runtime base file.txt"]);
      assert.deepEqual(result.evidence, []);
    }
    const result = await parse({
      "requirements.txt": `-c ${quote}base file.txt${quote}\n-r ${quote}base file.txt${quote}\n`,
      "base file.txt": "requests>=2\n",
    });
    assert.deepEqual(names(result), ["requests >=2 runtime base file.txt"]);
    const outside = await parse({ "requirements.txt": `-r ${quote}../base file.txt${quote}\n` });
    assert.equal(outside.evidence[0]?.kind, "requirements-include-skipped");
  }
});

it("does not follow unknown options that only start with a long include name", async () => {
  const result = await parse({
    "requirements.txt": "--requirementbase.txt\n--constraintpins.txt\n-r pins.txt\nrequests\n",
    "base.txt": "phantom\n",
    "pins.txt": "urllib3\n",
  });
  assert.deepEqual(names(result), [
    "urllib3 * runtime pins.txt",
    "requests * runtime requirements.txt",
  ]);
  assert.deepEqual(result.evidence, []);
});

it("preserves leading equals in attached short include filenames like pip", async () => {
  const result = await parse({
    "requirements.txt": "-r=base.txt\n-c=pins.txt\n-r =pins.txt\n",
    "=base.txt": "requests\n",
    "base.txt": "phantom\n",
    "=pins.txt": "urllib3\n",
    "pins.txt": "phantom-pins\n",
  });
  assert.deepEqual(names(result), ["requests * runtime =base.txt", "urllib3 * runtime =pins.txt"]);
  assert.deepEqual(result.evidence, []);
});

it("reads requirements-directory files with uppercase extensions detected as manifests", async () => {
  for (const name of ["BASE.TXT", "dev.IN", "base.Txt"]) {
    const file = `requirements/${name}`;
    const result = await parseManifests(
      memoryHandle({ [file]: "requests>=2\n", "app.py": "import requests\n" }),
      project,
    );
    assert.equal(result.requirements.length, 1, file);
    assert.equal(result.requirements[0]?.dependency.name, "requests");
    assert.equal(result.requirements[0]?.dependency.declaredIn, file);
  }
});

it("treats an uppercase or mixed-case .TXT as compiled output of its .IN source", async () => {
  const cases: [string, string][] = [
    ["requirements/BASE.IN", "requirements/BASE.TXT"],
    ["requirements/base.in", "requirements/base.TXT"],
    ["requirements.IN", "requirements.TXT"],
  ];
  for (const [source, compiled] of cases) {
    const result = await parseManifests(
      memoryHandle({
        [source]: "requests>=2\n",
        [compiled]: "requests==2.0\nurllib3==2.0\n",
        "app.py": "import requests\n",
      }),
      project,
    );
    assert.deepEqual(names(result), [`requests >=2 runtime ${source}`], `${source} + ${compiled}`);
    assert.equal(result.requirements[0]?.dependency.declaredIn, source);
  }
});
