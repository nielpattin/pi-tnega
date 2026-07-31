// Stash history — persistent storage of recent prompt texts.
// Pure data layer: file I/O, normalization, limit enforcement.
// No UI or extension state dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

export const STASH_HISTORY_LIMIT = 12;
export const STASH_PREVIEW_WIDTH = 72;

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function hasNonWhitespaceText(text: string): boolean {
   return text.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ═══════════════════════════════════════════════════════════════════════════
// Path
// ═══════════════════════════════════════════════════════════════════════════

function getStashHistoryPath(): string {
   const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
   return join(homeDir, ".pi", "agent", "pi-station", "stash-history.json");
}

// ═══════════════════════════════════════════════════════════════════════════
// Normalization
// ═══════════════════════════════════════════════════════════════════════════

export function normalizeStashHistoryEntries(value: unknown): string[] {
   if (!Array.isArray(value)) {
      return [];
   }

   const history: string[] = [];
   for (const entry of value) {
      if (typeof entry !== "string") {
         continue;
      }

      if (!hasNonWhitespaceText(entry)) {
         continue;
      }

      if (history[history.length - 1] === entry) {
         continue;
      }

      history.push(entry);
      if (history.length >= STASH_HISTORY_LIMIT) {
         break;
      }
   }

   return history;
}

// ═══════════════════════════════════════════════════════════════════════════
// Read / Write
// ═══════════════════════════════════════════════════════════════════════════

export function readPersistedStashHistory(): string[] {
   const stashHistoryPath = getStashHistoryPath();

   try {
      if (!existsSync(stashHistoryPath)) {
         return [];
      }

      const parsed = JSON.parse(readFileSync(stashHistoryPath, "utf8"));
      if (!isRecord(parsed)) {
         console.debug(`[station-bar] Ignoring invalid stash history at ${stashHistoryPath}`);
         return [];
      }

      return normalizeStashHistoryEntries(parsed.history);
   } catch (error) {
      console.debug(`[station-bar] Failed to read stash history from ${stashHistoryPath}:`, error);
      return [];
   }
}

export function persistStashHistory(history: string[]): void {
   const stashHistoryPath = getStashHistoryPath();
   const payload = {
      history: history.slice(0, STASH_HISTORY_LIMIT),
      version: 1
   };

   try {
      mkdirSync(dirname(stashHistoryPath), { recursive: true });
      writeFileSync(stashHistoryPath, `${JSON.stringify(payload, null, 2)}\n`);
   } catch (error) {
      console.debug(`[station-bar] Failed to persist stash history to ${stashHistoryPath}:`, error);
   }
}

// ═══════════════════════════════════════════════════════════════════════════
// Preview / Push
// ═══════════════════════════════════════════════════════════════════════════

export function buildStashPreview(text: string, maxWidth: number): string {
   const compact = text.replace(/\s+/g, " ").trim();
   if (!compact) {
      return "(empty)";
   }
   return truncateToWidth(compact, maxWidth, "...");
}

export function pushStashHistory(history: string[], text: string): boolean {
   if (!hasNonWhitespaceText(text)) {
      return false;
   }
   if (history[0] === text) {
      return false;
   }

   history.unshift(text);
   if (history.length > STASH_HISTORY_LIMIT) {
      history.length = STASH_HISTORY_LIMIT;
   }

   return true;
}
