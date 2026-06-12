const prettierConfig = require("eslint-config-prettier");

module.exports = [
  {
    // Ignore patterns
    ignores: [
      "crates/web-client/dist/**/*",
      "target/**/*",
      "**/target/**/*",
      "**/*.d.ts",
      "docs/**/*",
      "crates/idxdb-store/src/**",
      "packages/react-sdk/**",
      "packages/vite-plugin/**",
      "vitest.config.ts",
    ],
  },
  {
    // Configuration for JavaScript files
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      camelcase: ["error", { properties: "always" }],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: require("@typescript-eslint/parser"),
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "crates/web-client/tsconfig.json",
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      camelcase: ["error", { properties: "always" }],
    },
  },
  // Must be last: disables any stylistic rules that conflict with Prettier.
  prettierConfig,
];
