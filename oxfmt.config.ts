import { defineConfig } from "oxfmt";

export default defineConfig({
   ignorePatterns: [
      "dist",
      "build",
      "node_modules",
      "skills",
      "tests",
      "test",
      "*.test.ts",
      "settings.json",
      "mcp.json",
      "pnpm-workspace.yaml",
      "*yml",
   ],
   printWidth: 120,
   tabWidth: 3,
   overrides: [
      {
         files: ["*.md", "*.html"],
         options: {
            tabWidth: 4,
         },
      },
   ],
});
