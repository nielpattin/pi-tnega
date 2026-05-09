import { defineConfig } from "oxlint";

export default defineConfig({
   options: {
      typeAware: true,
      typeCheck: true,
   },
   env: {
      builtin: true,
   },
   ignorePatterns: [
      "skills/**",
      "**/pi-mcp-adapter/**",
      "**/test/**",
      "**/tests/**",
      "*.test.ts",
      "preciseVerboseReporter.ts",
   ],
   rules: {
      "eslint/no-control-regex": "off",
   },
});
