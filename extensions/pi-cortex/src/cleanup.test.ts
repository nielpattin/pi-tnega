import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteExistingFiles, deleteIndexArtifacts } from "./cleanup.js";

describe("Cortex cleanup", () => {
   it("does not report deletion when no index files exist", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-cortex-clean-"));
      try {
         await expect(deleteExistingFiles([join(dir, "pi-cortex.db")])).resolves.toEqual({ deleted: 0, failed: 0, failures: [] });
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });

   it("reports files that were actually removed", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-cortex-clean-"));
      const dbPath = join(dir, "pi-cortex.db");
      writeFileSync(dbPath, "index");
      try {
         await expect(deleteExistingFiles([dbPath])).resolves.toEqual({ deleted: 1, failed: 0, failures: [] });
         expect(existsSync(dbPath)).toBe(false);
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });

   it("counts a database and its sidecars as one index", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-cortex-clean-"));
      const dbPath = join(dir, "pi-cortex.db");
      const artifacts = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
      for (const path of artifacts) writeFileSync(path, "index");
      try {
         await expect(deleteIndexArtifacts(artifacts)).resolves.toEqual({ found: 1, deleted: 1, failed: 0, failures: [] });
         for (const path of artifacts) expect(existsSync(path)).toBe(false);
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });

   it("reports the filesystem error for an artifact it cannot remove", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-cortex-clean-"));
      const blocked = join(dir, "pi-cortex.db");
      mkdirSync(blocked);
      writeFileSync(join(blocked, "child"), "keep");
      try {
         const result = await deleteExistingFiles([blocked]);
         expect(result.deleted).toBe(0);
         expect(result.failed).toBe(1);
         expect(result.failures).toEqual([
            { path: blocked, code: expect.any(String), message: expect.any(String) }
         ]);
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });
});
