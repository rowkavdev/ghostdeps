import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".corpus-cache/",
      "**/dist/**",
      "site/**",
      "**/coverage/**",
      "**/node_modules/**",
      "fixtures/**",
    ],
  },
  js.configs.recommended,
  {
    // Repo scripts (corpus harness) and hostile/fixture adapter modules run
    // under Node, not the browser; give them the globals they use.
    files: ["scripts/**/*.mjs", "perf/**/*.mjs", "**/test/isolated-adapters/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        performance: "readonly",
        AbortSignal: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
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
