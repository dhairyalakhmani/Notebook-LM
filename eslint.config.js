// @ts-check

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import query from "@tanstack/eslint-plugin-query";
import prettier from "eslint-config-prettier";

const IGNORES = [
  "node_modules/",
  "web/dist/",
  "web/node_modules/",
  "data/",
  "storage/",
  "eval/results/",
  "coverage/",
];

export default tseslint.config(
  { ignores: IGNORES },

  js.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // eslint.config.js and scripts/*.mjs belong to no tsconfig.
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // A new Turn/ThreadItem/UploadState state must break every render site.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Catches the `styles.hit ?? ""` class of guard that can never fire.
      "@typescript-eslint/no-unnecessary-condition": "warn",
      // noUncheckedIndexedAccess is on; `!` throws its value away.
      "@typescript-eslint/no-non-null-assertion": "warn",

      // ── noise reduction, not correctness ────────────────────────────────
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",

      // `unknown` in a catch is the correct shape; the code narrows it.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  // ─────────────────────────────────────────── backend: Node, logs on purpose
  {
    files: ["main.ts", "scratch.ts", "src/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
      ecmaVersion: "latest",
    },
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ["web/serve.mjs", "web/api/**/*.mjs"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },

  // ─────────────────────────────────────────── frontend
  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
      "@tanstack/query": query,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      ...query.configs["flat/recommended"].rules,

      // A component must not print; it has states to render instead.
      "no-console": ["warn", { allow: ["warn", "error"] }],

      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Use request()/requestText() from shared/lib/http.ts." },
      ],

      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='setInterval'], MemberExpression[property.name='setInterval']",
          message:
            "setInterval belongs in shared/lib (useCountdown). Simulated progress is how this UI shipped lying about what the backend did.",
        },
        {
          selector: "CallExpression[callee.property.name=/^querySelector(All)?$/] TemplateLiteral",
          message:
            "Do not build a DOM selector from a CSS-module class name - it silently becomes '.undefined'. Mark the element with a data-* attribute and query that.",
        },
      ],
    },
  },

  {
    files: ["web/src/shared/lib/**"],
    rules: {
      "no-restricted-syntax": "off",
      "no-restricted-globals": "off",
    },
  },

  // ─────────────────────────────────────────── tests
  {
    files: ["test/**/*.ts", "web/src/**/*.test.{ts,tsx}", "web/src/test/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: [
                "describe",
                "it",
                "test",
                "suite",
                "before",
                "after",
                "beforeEach",
                "afterEach",
              ],
            },
          ],
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "no-console": "off",
    },
  },

  // Formatting is Prettier's job. Must stay last so it wins.
  prettier,
);
