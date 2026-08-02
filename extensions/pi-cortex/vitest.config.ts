import { defineConfig } from "vitest/config";

export default defineConfig({
   test: {
      include: ["index.test.ts", "src/*.test.ts"],
      testTimeout: 60000,
      hookTimeout: 60000
   }
});
