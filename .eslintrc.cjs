module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  env: {
    node: true,
    es2022: true,
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  ignorePatterns: ["dist/", "node_modules/", "*.js", "*.cjs"],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "no-console": ["error", { allow: ["error", "warn"] }],
  },
  overrides: [
    {
      files: ["**/*.test.ts"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
      },
    },
    {
      files: ["src/cli/**/*.ts"],
      rules: {
        "no-console": "off",
        "no-constant-condition": ["error", { checkLoops: false }],
      },
    },
  ],
};
