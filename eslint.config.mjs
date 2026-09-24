import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "fixtures/**"],
  },
  js.configs.recommended,
  {
    // Hostile/fixture adapter modules run in worker threads, not the browser;
    // give them the node globals they intentionally exercise.
    files: ["**/test/isolated-adapters/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
