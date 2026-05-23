import { defineConfig } from "vitest/config";

import { PreciseVerboseReporter } from "./preciseVerboseReporter";

export default defineConfig({
   test: {
      environment: "node",
      include: ["extensions/**/*.test.ts", "tests/**/*.test.ts"],
      reporters: [new PreciseVerboseReporter()],
      restoreMocks: true,
      clearMocks: true,
   },
});
