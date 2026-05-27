import { defineConfig } from "oxlint";

export default defineConfig({
   plugins: ["eslint"],
   options: {
      typeAware: true,
      typeCheck: true
   },
   env: {
      builtin: true
   },
   ignorePatterns: [
      "skills/**",
      "**/pi-mcp-adapter/**",
      "**/test/**",
      "**/tests/**",
      "*.test.ts",
      "preciseVerboseReporter.ts",
      "*/recover-mimo-thinking.ts",
      "*/treepluss/**"
   ],
   rules: {
      "eslint/no-control-regex": "off"
   }
});
