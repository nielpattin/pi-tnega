import { defineConfig } from "oxlint";

export default defineConfig({
   plugins: ["typescript", "unicorn", "import", "eslint"],
   categories: {
      correctness: "error",
      perf: "warn",
      suspicious: "warn",
      style: "off"
   },
   options: {
      typeAware: true,
      typeCheck: true
   },
   rules: {
      "no-control-regex": "off",
      "eslint/no-control-regex": "off",
      "eslint/no-unused-vars": "off",
      "eslint/no-ternary": "off",
      "eslint/no-magic-numbers": "off",
      "eslint/func-style": "off",
      "eslint/max-statements": "off",
      "eslint/max-params": "off",
      "eslint/id-length": "off",
      "eslint/no-continue": "off",
      "eslint/sort-imports": "off",
      "eslint/no-nested-ternary": "off",
      "eslint/prefer-destructuring": "off",
      "eslint/new-cap": "off",
      "eslint/init-declarations": "off",
      "eslint/no-underscore-dangle": "off",
      "unicorn/no-null": "off",
      "unicorn/no-nested-ternary": "off",
      "unicorn/consistent-function-scoping": "off",
      "import/no-nodejs-modules": "off",
      "import/no-namespace": "off",
      "import/consistent-type-specifier-style": "off",
      "typescript/no-misused-spread": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-base-to-string": "error"
   },
   env: {
      builtin: true
   },
   ignorePatterns: [
      "**/pi-mcp-adapter/**",
      "**/node_modules/**",
      "repos/**",
      "tests/**",
      "examples/**",
      "scripts/**",
      "dist/**",
      "build/**"
   ]
});
