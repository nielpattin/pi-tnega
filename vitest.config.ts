import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
   test: {
      environment: "node",
      include: ["extensions/**/*.test.ts", "tests/**/*.test.ts"],
      exclude: [
         ...configDefaults.exclude,
         "extensions/pi-intercom/**/*.test.ts",
         "extensions/pi-mcp-adapter/**/*.test.ts"
      ],
      restoreMocks: true,
      clearMocks: true
   }
});
