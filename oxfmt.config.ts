import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "dist",
    "build",
    "node_modules",
    "settings.json",
    "mcp.json",
    "pnpm-workspace.yaml",
    "*yml",
    ".pi/**",
    "**/.pi/**",
    "workflows/**",
    "**/rust-embedder/models/**",
    "**/rust-embedder/target/**",
    "*.json",
    "*.lock",
    "*.tsbuildinfo",
    "tests/**",
    "examples/**",
  ],
  trailingComma: "all",
  objectWrap: "collapse",
  printWidth: 100,
  tabWidth: 2,
  overrides: [{ files: ["*.md", "*.html"], options: { tabWidth: 4 } }],
});
