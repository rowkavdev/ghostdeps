/**
 * Capability catalogue (#55, #58): which packages do the same job, as data.
 *
 * A cluster names one capability ("http-client") and the packages that
 * provide it, per ecosystem. #55 uses it for the cross-ecosystem overlap
 * view (information only, never a verdict). #58 builds same-ecosystem
 * duplicate detection on the same data.
 *
 * The shape is versioned: bump CAPABILITY_CATALOGUE_VERSION when a field
 * is added, removed or changes meaning. Adding clusters or members is not a
 * shape change.
 *
 * Version 2 (#211): clusters gain `crossEcosystem`.
 */

export const CAPABILITY_CATALOGUE_VERSION = 2;

/** One package in a cluster. Names are as declared in the manifest. */
export interface CapabilityMember {
  ecosystem: string;
  name: string;
}

/** One capability and the packages that provide it. */
export interface CapabilityCluster {
  /** Stable id, e.g. "http-client". */
  id: string;
  /** Plain-language label, e.g. "HTTP client". */
  label: string;
  members: CapabilityMember[];
  /**
   * Whether the cross-ecosystem overlap view (#55) reports this cluster.
   * Omitted means true. False for capabilities every polyglot repo has in
   * each ecosystem (test runners), where the note can't be acted on. The
   * cluster still counts for same-ecosystem duplicates (#58).
   */
  crossEcosystem?: boolean;
}

export interface CapabilityCatalogue {
  version: number;
  clusters: CapabilityCluster[];
}

const JS = "javascript-typescript";
const PY = "python";

const m = (ecosystem: string, names: string[]): CapabilityMember[] =>
  names.map((name) => ({ ecosystem, name }));

export const CAPABILITY_CATALOGUE: CapabilityCatalogue = {
  version: CAPABILITY_CATALOGUE_VERSION,
  clusters: [
    {
      id: "http-client",
      label: "HTTP client",
      members: [
        ...m(JS, [
          "axios",
          "got",
          "node-fetch",
          "cross-fetch",
          "superagent",
          "undici",
          "ky",
          "request",
        ]),
        ...m(PY, ["requests", "httpx", "aiohttp", "urllib3"]),
      ],
    },
    {
      id: "date-time",
      label: "date and time handling",
      members: [
        ...m(JS, ["moment", "dayjs", "date-fns", "luxon"]),
        ...m(PY, ["arrow", "pendulum", "python-dateutil"]),
      ],
    },
    {
      id: "schema-validation",
      label: "schema validation",
      members: [
        ...m(JS, ["zod", "joi", "yup", "ajv", "valibot"]),
        ...m(PY, ["pydantic", "marshmallow", "jsonschema", "cerberus"]),
      ],
    },
    {
      id: "logging",
      label: "logging",
      members: [
        ...m(JS, ["winston", "pino", "bunyan", "loglevel"]),
        ...m(PY, ["loguru", "structlog"]),
      ],
    },
    {
      id: "yaml",
      label: "YAML parsing",
      members: [...m(JS, ["js-yaml", "yaml"]), ...m(PY, ["pyyaml", "ruamel-yaml"])],
    },
    {
      id: "test-runner",
      label: "test runner",
      // pytest next to vitest/jest is normal in a JS + Python repo (#211).
      crossEcosystem: false,
      members: [...m(JS, ["jest", "mocha", "vitest", "ava", "tap"]), ...m(PY, ["pytest", "nose2"])],
    },
  ],
};

/**
 * Normalises a package name for catalogue matching. Python names follow
 * PEP 503 (case-insensitive; runs of "-", "_" and "." are equal). Other
 * ecosystems match exactly.
 */
export function catalogueName(ecosystem: string, name: string): string {
  return ecosystem === PY ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}
