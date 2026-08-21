const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const prettierConfig = require("eslint-config-prettier");

// No `parserOptions.project`: the rules below are purely syntactic, and
// requiring a project would exclude `src/__tests__` — tsconfig.json leaves
// the tests out so they stay out of the published build, and linting the
// tests matters more here than type-aware rules nobody has asked for.
module.exports = [
  {
    ignores: ["dist/**/*", "node_modules/**/*", "**/*.d.ts"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      camelcase: ["error", { properties: "always" }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  // Must be last: disables any stylistic rules that conflict with Prettier.
  prettierConfig,
];
