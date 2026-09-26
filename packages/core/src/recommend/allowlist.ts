/**
 * Curated dev-tooling allowlist (#121). Packages here are used by tools,
 * scripts and build steps rather than imported from source, so import
 * analysis alone would wrongly call them unused. A match counts as usage:
 * the policy never emits an "unused" verdict for them.
 *
 * Data, not code: extend per ecosystem with a PR and a sentence of why.
 * Callers can add entries through PolicyConfig.allowlist.
 */
export interface ToolingAllowlist {
  /** Exact package names. */
  exact: readonly string[];
  /** Name prefixes, e.g. "@types/" or "eslint-plugin-". */
  prefixes: readonly string[];
}

export const DEFAULT_TOOLING_ALLOWLIST: Readonly<Record<string, ToolingAllowlist>> = {
  "javascript-typescript": {
    exact: [
      // compilers and runtimes for TS
      "typescript",
      "tslib", // imported implicitly by compiled output (importHelpers)
      "tsx",
      "ts-node",
      // linters and formatters
      "eslint",
      "typescript-eslint",
      "prettier",
      "@biomejs/biome",
      "stylelint",
      // test runners and coverage
      "vitest",
      "jest",
      "mocha",
      "ava",
      "tap",
      "c8",
      "nyc",
      "playwright",
      "@playwright/test",
      "cypress",
      // bundlers and build tools
      "vite",
      "esbuild",
      "rollup",
      "webpack",
      "webpack-cli",
      "parcel",
      "tsup",
      "turbo",
      "nx",
      "@swc/core",
      "@babel/core",
      "@babel/cli",
      // repo tooling
      "husky",
      "lint-staged",
      "nodemon",
      "concurrently",
      "npm-run-all",
      "npm-run-all2",
      "rimraf",
      "cross-env",
      "semantic-release",
      "release-please",
    ],
    prefixes: [
      "eslint-config-",
      "eslint-plugin-",
      "@eslint/",
      "@typescript-eslint/",
      "prettier-plugin-",
      "@vitejs/",
      "vite-plugin-",
      "@rollup/",
      "rollup-plugin-",
      "@babel/preset-",
      "@babel/plugin-",
      "babel-plugin-",
      "babel-preset-",
      "@swc/",
      "@commitlint/",
      "@changesets/",
      "stylelint-config-",
    ],
  },
  python: {
    exact: [
      "pytest",
      "coverage",
      "black",
      "ruff",
      "mypy",
      "flake8",
      "isort",
      "pylint",
      "pre-commit",
      "tox",
      "nox",
      "build",
      "twine",
      "hatchling",
      "setuptools",
      "wheel",
    ],
    prefixes: ["pytest-", "flake8-", "types-", "mypy-"],
  },
};

export function isAllowlisted(
  name: string,
  ecosystem: string,
  allowlists: Readonly<Record<string, ToolingAllowlist>>,
): boolean {
  const list = allowlists[ecosystem];
  if (!list) return false;
  return list.exact.includes(name) || list.prefixes.some((prefix) => name.startsWith(prefix));
}

/** Merge caller additions onto the defaults, per ecosystem. */
export function mergeAllowlists(
  base: Readonly<Record<string, ToolingAllowlist>>,
  extra: Readonly<Record<string, Partial<ToolingAllowlist>>> = {},
): Record<string, ToolingAllowlist> {
  const merged: Record<string, ToolingAllowlist> = { ...base };
  for (const [ecosystem, add] of Object.entries(extra)) {
    const current = merged[ecosystem] ?? { exact: [], prefixes: [] };
    merged[ecosystem] = {
      exact: [...current.exact, ...(add.exact ?? [])],
      prefixes: [...current.prefixes, ...(add.prefixes ?? [])],
    };
  }
  return merged;
}
