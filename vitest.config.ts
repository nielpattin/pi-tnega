import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
   test: {
      environment: "node",
      include: ["packages/pi-*/**/*.test.ts", "tests/**/*.test.ts"],
      exclude: [
         ...configDefaults.exclude,
         "extensions/background-terminals/**",
         "extensions/subagents/**",
         "extensions/workflows/**",
         "extensions/pi-skill-toggle/**",
         "extensions/pi-intercom/**/*.test.ts",
         "extensions/pi-mcp-adapter/**/*.test.ts"
      ],
      coverage: {
         provider: "v8",
         reporter: ["text", "json", "html"],
         thresholds: {
            global: {
               branches: 50,
               functions: 70,
               lines: 60,
               statements: 60
            }
         }
      },
      restoreMocks: true,
      clearMocks: true
   }
});
