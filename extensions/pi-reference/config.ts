import path from "path";
import os from "os";
import { readFile } from "fs/promises";
import type { Source, ReferenceEntry, LocalEntryConfig, GitEntryConfig } from "./types.js";

// ─── Alias validation ──────────────────────────────────────────────

const ALIAS_RE = /^[^\s/`,]+$/;

export function validAlias(name: string): boolean {
   return name.length > 0 && ALIAS_RE.test(name);
}

// ─── String shorthand disambiguation ──────────────────────────────

/**
 * A string is local if it starts with ".", "/", or "~".
 * Otherwise it's treated as a git repo (owner/repo).
 */
export function isLocalShorthand(value: string): boolean {
   return value.startsWith(".") || value.startsWith("/") || value.startsWith("~");
}

// ─── Path resolution ──────────────────────────────────────────────

export function expandHome(p: string): string {
   if (p === "~") return os.homedir();
   if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
   if (p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
   return p;
}

export function resolveLocalPath(value: string, baseDir: string): string {
   const expanded = expandHome(value);
   if (path.isAbsolute(expanded)) return path.resolve(expanded);
   return path.resolve(baseDir, expanded);
}

// ─── Entry parsing ────────────────────────────────────────────────

export function parseEntry(name: string, entry: ReferenceEntry, baseDir: string): Source | null {
   if (typeof entry === "string") {
      if (isLocalShorthand(entry)) {
         return {
            type: "local",
            path: resolveLocalPath(entry, baseDir)
         };
      }
      // Git shorthand: owner/repo
      return {
         type: "git",
         repository: entry
      };
   }

   if (typeof entry === "object" && entry !== null) {
      if ("path" in entry) {
         const local = entry as LocalEntryConfig;
         return {
            type: "local",
            path: resolveLocalPath(local.path, baseDir),
            description: local.description,
            hidden: local.hidden
         };
      }
      if ("repository" in entry) {
         const git = entry as GitEntryConfig;
         return {
            type: "git",
            repository: git.repository,
            branch: git.branch,
            description: git.description,
            hidden: git.hidden
         };
      }
   }

   return null;
}

// ─── Settings reading ─────────────────────────────────────────────

function getGlobalSettingsPath(): string {
   return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
   return path.join(cwd, ".pi", "settings.json");
}

async function readSettingsFile(filePath: string): Promise<Record<string, unknown> | null> {
   try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw);
   } catch {
      return null;
   }
}

function extractReferences(settings: Record<string, unknown> | null): Record<string, ReferenceEntry> | null {
   if (!settings) return null;
   const refs = (settings as Record<string, unknown>).references;
   if (!refs || typeof refs !== "object" || Array.isArray(refs)) return null;
   return refs as Record<string, ReferenceEntry>;
}

export interface ResolvedReferences {
   sources: Map<string, Source>;
   baseDir: string;
}

/**
 * Read references from global + project settings.
 * Returns a Map of alias → Source, with project overriding global per-alias.
 * Also returns the effective baseDir (cwd) for path normalization.
 */
export async function readReferences(cwd: string): Promise<Map<string, Source>> {
   const result = new Map<string, Source>();

   // Global settings: resolve paths relative to home dir
   const globalSettings = await readSettingsFile(getGlobalSettingsPath());
   const globalRefs = extractReferences(globalSettings);
   if (globalRefs) {
      const homeDir = os.homedir();
      for (const [alias, entry] of Object.entries(globalRefs)) {
         if (!validAlias(alias)) continue;
         const source = parseEntry(alias, entry, homeDir);
         if (source) result.set(alias, source);
      }
   }

   // Project settings: resolve paths relative to cwd (overrides global per-alias)
   const projectSettings = await readSettingsFile(getProjectSettingsPath(cwd));
   const projectRefs = extractReferences(projectSettings);
   if (projectRefs) {
      for (const [alias, entry] of Object.entries(projectRefs)) {
         if (!validAlias(alias)) continue;
         const source = parseEntry(alias, entry, cwd);
         if (source) result.set(alias, source);
      }
   }

   return result;
}
