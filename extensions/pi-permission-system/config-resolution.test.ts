import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPermissionConfigForTest } from "./index.ts";
import { evaluate } from "./evaluator.ts";

function withTempDirs(fn: (agentDir: string, cwd: string) => void): void {
   const root = join(tmpdir(), `pi-permission-config-${Date.now()}-${Math.random().toString(16).slice(2)}`);
   const agentDir = join(root, "agent");
   const cwd = join(root, "project");
   mkdirSync(agentDir, { recursive: true });
   mkdirSync(join(cwd, ".pi"), { recursive: true });
   try {
      fn(agentDir, cwd);
   } finally {
      rmSync(root, { recursive: true, force: true });
   }
}

describe("permission config resolution", () => {
   it("loads global permission.jsonc and merges project .pi/permission.jsonc override", () => {
      withTempDirs((agentDir, cwd) => {
         writeFileSync(
            join(agentDir, "permission.jsonc"),
            `{
              // global default
              "debugLog": true,
              "permission": {
                "bash": { "*": "ask", },
                "edit": "deny",
              },
            }`,
            "utf8",
         );
         writeFileSync(
            join(cwd, ".pi", "permission.jsonc"),
            `{
              "permissionReviewLog": true,
              "permission": {
                "bash": { "git status": "allow" },
                "read": "ask",
              },
            }`,
            "utf8",
         );

         const config = loadPermissionConfigForTest(cwd, agentDir);

         expect(config.paths).toEqual([join(agentDir, "permission.jsonc"), join(cwd, ".pi", "permission.jsonc")]);
         expect(config.debugLog).toBe(true);
         expect(config.permissionReviewLog).toBe(true);
         expect(evaluate(config.rules, "bash", "ls -la")).toBe("ask");
         expect(evaluate(config.rules, "bash", "git status")).toBe("allow");
         expect(evaluate(config.rules, "edit", "README.md")).toBe("deny");
         expect(evaluate(config.rules, "read", "README.md")).toBe("ask");
      });
   });
});
