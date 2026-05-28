import { configDefaults, defineConfig } from "vitest/config";

import { PreciseVerboseReporter } from "./preciseVerboseReporter";

export default defineConfig({
   test: {
      environment: "node",
      include: ["extensions/**/*.test.ts", "tests/**/*.test.ts"],
      exclude: [
         ...configDefaults.exclude,
         "extensions/pi-intercom/**/*.test.ts",
         "extensions/pi-mcp-adapter/**/*.test.ts"
      ],
      reporters: [new PreciseVerboseReporter()],
      restoreMocks: true,
      clearMocks: true
   }
});
