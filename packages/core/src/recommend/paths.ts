/**
 * Non-shipped source classification for the should-be-dev rule. A path is
 * non-shipped when it is clearly test, build, tooling or config code.
 * Deliberately narrow: anything unrecognised counts as shipped, so the
 * rule stays quiet rather than wrong.
 */
const NON_SHIPPED_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "spec",
  "specs",
  "e2e",
  "cypress",
  "playwright",
  "fixtures",
  "benchmark",
  "benchmarks",
  "bench",
  "scripts",
  ".storybook",
  "stories",
]);

const NON_SHIPPED_FILE = [
  /\.(test|spec|e2e|bench|stories)\.[cm]?[jt]sx?$/,
  /(^|\/)[^/]+\.config\.[cm]?[jt]s$/, // vite.config.ts, jest.config.cjs, ...
  /(^|\/)\.[^/]+rc\.[cm]?[jt]s$/, // .eslintrc.cjs, .prettierrc.js
  /(^|\/)(conftest|noxfile)\.py$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+_test\.py$/,
];

export function isNonShippedPath(file: string): boolean {
  const parts = file.split("/");
  if (parts.slice(0, -1).some((part) => NON_SHIPPED_DIRECTORIES.has(part))) return true;
  return NON_SHIPPED_FILE.some((pattern) => pattern.test(file));
}
