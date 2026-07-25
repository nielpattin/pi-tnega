import * as path from "node:path";

function isGitBashShell(shellPath: string): boolean {
   const base = path.basename(shellPath).toLowerCase();
   if (base === "sh.exe" || base === "bash.exe" || base === "sh" || base === "bash") {
      return true;
   }
   const dir = path.dirname(shellPath).toLowerCase().replace(/\\/g, "/");
   return dir.endsWith("usr/bin");
}

function gitPathPrefixes(shellPath: string): string[] {
   const usrBin = path.normalize(path.dirname(shellPath));
   const gitBin = path.normalize(path.join(usrBin, "..", "..", "bin"));
   return [usrBin, gitBin];
}

function mergePathPrefixes(
   existingPath: string | undefined,
   prefixes: readonly string[],
   delimiter: string = path.delimiter
): string {
   const parts = (existingPath ?? "").split(delimiter).filter((p) => p.length > 0);
   const seen = new Set(parts.map((p) => p.toLowerCase()));
   const head: string[] = [];
   for (const prefix of prefixes) {
      if (!prefix) continue;
      if (seen.has(prefix.toLowerCase())) continue;
      head.push(prefix);
      seen.add(prefix.toLowerCase());
   }
   return [...head, ...parts].join(delimiter);
}

/**
 * Build an environment object for a spawned child process.
 *
 * Returns a shallow copy of `parentEnv`. When `shellPath` points to a Git Bash
 * shell, the directory containing the shell and its sibling `..\..\bin`
 * (Git\bin) are prepended to PATH so Unix helpers (sed, uname) and POSIX
 * corepack shims (pnpm) resolve on Windows.
 *
 * Pure: does not read `process.env` and does not mutate `parentEnv`.
 */
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv, shellPath: string): NodeJS.ProcessEnv {
   if (!isGitBashShell(shellPath)) {
      return { ...parentEnv };
   }
   const pathKey = Object.keys(parentEnv).find((k) => k.toLowerCase() === "path") ?? "PATH";
   const prefixes = gitPathPrefixes(shellPath);
   return {
      ...parentEnv,
      [pathKey]: mergePathPrefixes(parentEnv[pathKey], prefixes)
   };
}
