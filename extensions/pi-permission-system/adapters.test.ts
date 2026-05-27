import { describe, it, expect } from "vitest";
import {
   bashAdapter,
   bashAlwaysPattern,
   editAdapter,
   editAlwaysPattern,
   readAdapter,
   taskAdapter,
   externalDirectoryAdapter,
   externalDirectoryAlwaysPattern,
} from "./adapters.ts";
import { PermissionService } from "./service.ts";
import type { Rule } from "./types.ts";

describe("tool adapters", () => {
   describe("bashAdapter", () => {
      it("generates correct patterns for a command", () => {
         const req = bashAdapter("git status");
         expect(req.permission).toBe("bash");
         expect(req.patterns).toContain("git status");
         expect(req.patterns).toContain("git *");
         expect(req.patterns).toContain("*");
      });

      it("includes command metadata", () => {
         const req = bashAdapter("git push origin main");
         expect(req.metadata.command).toBe("git push origin main");
         expect(req.metadata.commandName).toBe("git");
         expect(req.metadata.args).toEqual(["push", "origin", "main"]);
      });

      it("derives always pattern from command", () => {
         expect(bashAlwaysPattern("git push origin main")).toBe("git *");
         expect(bashAlwaysPattern("npm install")).toBe("npm *");
      });
   });

   describe("editAdapter", () => {
      it("generates correct patterns for a file edit", () => {
         const req = editAdapter("/home/user/project/src/index.ts", "old", "new");
         expect(req.permission).toBe("edit");
         expect(req.patterns).toContain("/home/user/project/src/index.ts");
         expect(req.patterns).toContain("*.ts");
         expect(req.patterns).toContain("/home/user/project/src/**");
         expect(req.patterns).toContain("*");
      });

      it("includes diff metadata", () => {
         const req = editAdapter("/tmp/file.ts", "old text", "new text");
         expect(req.metadata.filePath).toBe("/tmp/file.ts");
         expect(req.metadata.extension).toBe(".ts");
         expect(req.metadata.diff).toContain("--- a/");
         expect(req.metadata.diff).toContain("-old text");
         expect(req.metadata.diff).toContain("+new text");
      });

      it("derives always pattern from file extension", () => {
         expect(editAlwaysPattern("/path/to/file.ts")).toBe("*.ts");
         expect(editAlwaysPattern("/path/to/file.json")).toBe("*.json");
      });
   });

   describe("readAdapter", () => {
      it("generates correct patterns for a file read", () => {
         const req = readAdapter("/home/user/project/package.json");
         expect(req.permission).toBe("read");
         expect(req.patterns).toContain("/home/user/project/package.json");
         expect(req.patterns).toContain("*.json");
         expect(req.patterns).toContain("*");
      });

      it("includes path metadata", () => {
         const req = readAdapter("/home/user/project/src");
         expect(req.metadata.path).toBe("/home/user/project/src");
         expect(req.metadata.isAbsolute).toBe(true);
      });
   });

   describe("taskAdapter", () => {
      it("generates correct patterns for a task", () => {
         const req = taskAdapter("Implement feature X", "explorer");
         expect(req.permission).toBe("task");
         expect(req.patterns).toContain("explorer *");
         expect(req.patterns).toContain("*");
      });

      it("includes task metadata", () => {
         const req = taskAdapter("Build the UI", "builder", { priority: "high" });
         expect(req.metadata.taskDescription).toBe("Build the UI");
         expect(req.metadata.agentName).toBe("builder");
         expect(req.metadata.priority).toBe("high");
      });
   });

   describe("externalDirectoryAdapter", () => {
      it("generates correct patterns for external directory access", () => {
         const req = externalDirectoryAdapter("/home/user/other-project");
         expect(req.permission).toBe("external_directory");
         expect(req.patterns).toContain("/home/user/other-project");
         expect(req.patterns).toContain("/home/user/other-project/**");
         expect(req.patterns).toContain("/home/user/**");
         expect(req.patterns).toContain("*");
      });

      it("derives always pattern for directory", () => {
         expect(externalDirectoryAlwaysPattern("/home/user/project")).toBe("/home/user/project/**");
      });
   });
});

describe("permission-blocked execution paths", () => {
   const denyAllRules: Rule[] = [
      { permission: "*", pattern: "*", action: "deny" },
   ];

   const askBashRules: Rule[] = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git *", action: "ask" },
   ];

   it("bash command is denied by deny rule", async () => {
      const service = new PermissionService({ configRules: denyAllRules });
      const req = bashAdapter("git status");
      const result = await service.ask(req.permission, req.patterns, req.metadata, "s1");
      expect(result).toBe("deny");
   });

   it("bash command triggers ask flow when no allow rule", async () => {
      const service = new PermissionService({ configRules: askBashRules });
      const req = bashAdapter("git push");
      const promise = service.ask(req.permission, req.patterns, req.metadata, "s1");

      expect(service.pendingCount).toBe(1);
      const pending = service.listPending();
      expect(pending[0].permission).toBe("bash");
      expect(pending[0].metadata.command).toBe("git push");

      // Reply once to unblock
      service.reply({ requestId: pending[0].id, decision: "once" });
      const result = await promise;
      expect(result).toBe("allow");
   });

   it("edit operation is allowed by wildcard rule", async () => {
      const service = new PermissionService({
         configRules: [{ permission: "edit", pattern: "*", action: "allow" }],
      });
      const req = editAdapter("/tmp/file.ts", "old", "new");
      const result = await service.ask(req.permission, req.patterns, req.metadata, "s1");
      expect(result).toBe("allow");
   });

   it("read operation respects path deny rules", async () => {
      const service = new PermissionService({
         configRules: [
            { permission: "read", pattern: "*", action: "allow" },
            { permission: "read", pattern: "*.env", action: "deny" },
         ],
      });

      const reqSafe = readAdapter("/tmp/config.ts");
      const resultSafe = await service.ask(reqSafe.permission, reqSafe.patterns, reqSafe.metadata, "s1");
      expect(resultSafe).toBe("allow");

      const reqDeny = readAdapter("/tmp/secrets.env");
      const resultDeny = await service.ask(reqDeny.permission, reqDeny.patterns, reqDeny.metadata, "s1");
      expect(resultDeny).toBe("deny");
   });

   it("external directory triggers ask by default", async () => {
      const service = new PermissionService({ configRules: [] });
      const req = externalDirectoryAdapter("/home/user/other-project");
      const promise = service.ask(req.permission, req.patterns, req.metadata, "s1");

      expect(service.pendingCount).toBe(1);
      const pending = service.listPending();
      expect(pending[0].permission).toBe("external_directory");

      service.reply({ requestId: pending[0].id, decision: "always" });
      const result = await promise;
      expect(result).toBe("allow");

      // Future access to same directory should be allowed
      const req2 = externalDirectoryAdapter("/home/user/other-project");
      const result2 = await service.ask(req2.permission, req2.patterns, req2.metadata, "s1");
      expect(result2).toBe("allow");
   });
});
