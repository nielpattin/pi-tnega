import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LockCandidate, LockFile } from "./protocol";
import { workspaceMatchesCwd } from "./autocomplete";

export function lockDirectory(home = homedir()): string {
   return join(home, ".pi", "pi-ide-pro", "lock");
}

export function createAuthToken(): string {
   return randomBytes(32).toString("hex");
}

export function createLockFilePath(port: number, pid = process.pid, home = homedir()): string {
   return join(lockDirectory(home), `vscode-${pid}-${port}.lock`);
}

export function createLockFile(input: {
   port: number;
   authToken: string;
   workspaceFolders: string[];
   name?: string;
   pid?: number;
   now?: Date;
}): LockFile {
   const now = (input.now ?? new Date()).toISOString();
   return {
      version: 1,
      name: input.name ?? "Pi IDE Pro VS Code",
      host: "127.0.0.1",
      port: input.port,
      authToken: input.authToken,
      workspaceFolders: input.workspaceFolders,
      pid: input.pid ?? process.pid,
      createdAt: now,
      updatedAt: now
   };
}

export async function writeLockFile(path: string, lock: LockFile): Promise<void> {
   const directory = resolve(path, "..");
   await mkdir(directory, { recursive: true, mode: 0o700 });
   await chmod(directory, 0o700).catch(() => undefined);
   const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
   await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
   await chmod(temporary, 0o600).catch(() => undefined);
   await rename(temporary, path);
   await chmod(path, 0o600).catch(() => undefined);
}

export async function removeLockFile(path: string | undefined): Promise<void> {
   if (path) await rm(path, { force: true }).catch(() => undefined);
}

export async function discoverCandidates(cwd: string, home = homedir()): Promise<LockCandidate[]> {
   const directory = lockDirectory(home);
   let names: string[];
   try {
      names = await readdir(directory);
   } catch {
      return [];
   }

   const candidates: LockCandidate[] = [];
   for (const name of names) {
      if (!name.endsWith(".lock")) continue;
      const path = join(directory, name);
      try {
         const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
         const lock = JSON.parse(raw) as LockFile;
         const workspaceFolder = lock.workspaceFolders.find((folder) => workspaceMatchesCwd([folder], cwd));
         if (!workspaceFolder) continue;
         candidates.push({ path, lock, mtimeMs: info.mtimeMs, workspaceFolder });
      } catch {
         await rm(path, { force: true }).catch(() => undefined);
      }
   }

   return candidates.toSorted((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}
