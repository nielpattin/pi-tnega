/**
 * Reference-aware autocomplete provider for `@alias` file browsing.
 *
 * Wraps the built-in autocomplete provider. When the user types `@`:
 *   - `@` alone            → list all reference aliases (+ delegate to built-in for project files)
 *   - `@partial`           → fuzzy-match reference aliases
 *   - `@alias/`            → list files/dirs inside that reference's directory
 *   - `@alias/path/`       → drill into subdirectories
 *
 * On submission, the `input` event handler resolves `@alias/path` tokens
 * to actual file content and injects it into the prompt.
 */

import { readdirSync, statSync, readFileSync } from "fs";
import { join, basename, dirname } from "path";
import type { ReferenceInfo } from "./types.js";
import type { AutocompleteProvider, AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";

// ─── ANSI colors for label rendering ─────────────────────
// The SelectList supports ANSI codes in labels (visibleWidth strips them).
// Cyan marks the @alias prefix for visual distinction in the picker.
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

// ─── Path delimiter detection (matches built-in) ─────────────────

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function findLastDelimiter(text: string): number {
   for (let i = text.length - 1; i >= 0; i--) {
      if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
   }
   return -1;
}

/** Extract the `@`-prefixed token from text before cursor. Returns null if not an @ token. */
export function extractAtToken(textBeforeCursor: string): string | null {
   // Handle quoted @" prefix
   const quotedMatch = textBeforeCursor.match(/@"[^"]*$/);
   if (quotedMatch) return quotedMatch[0];

   const lastDelim = findLastDelimiter(textBeforeCursor);
   const tokenStart = lastDelim === -1 ? 0 : lastDelim + 1;
   if (textBeforeCursor[tokenStart] === "@") {
      return textBeforeCursor.slice(tokenStart);
   }
   return null;
}

/**
 * Detect a just-completed reference alias token terminated by a delimiter.
 * Returns the matched alias name if the text before cursor ends with
 * `@<alias>` followed by a path delimiter (space, tab, newline, `=`),
 * where `<alias>` is a known reference. This lets the provider suppress
 * the built-in fuzzy search that would otherwise leak project-file
 * suggestions after a reference alias is selected.
 */
export function extractCompletedReferenceAlias(textBeforeCursor: string, references: ReferenceInfo[]): string | null {
   const refNames = references.map((r) => r.name);
   for (const name of refNames) {
      const token = `@${name}`;
      // Token must be immediately preceded by start-of-text or a delimiter
      const idx = textBeforeCursor.lastIndexOf(token);
      if (idx === -1) continue;
      // The char right after the token must be a delimiter (space/tab/=)
      const after = textBeforeCursor[idx + token.length];
      if (after === " " || after === "\t" || after === "\n" || after === "=") {
         // And the char right before the token must be start-of-text or a delimiter
         const before = idx === 0 ? "" : textBeforeCursor[idx - 1];
         if (idx === 0 || before === " " || before === "\t" || before === "\n" || before === "=") {
            return name;
         }
      }
   }
   return null;
}

/** Parse an @ token into alias and path-after-alias parts. Returns null if not a reference token. */
export function parseReferenceToken(
   atToken: string,
   references: ReferenceInfo[]
): { alias: string; refPath: string; reference: ReferenceInfo; remainder: string } | null {
   // Strip @ and optional quote
   let raw = atToken;
   if (raw.startsWith("@") && raw[1] === '"') {
      raw = raw.slice(2);
   } else if (raw.startsWith("@")) {
      raw = raw.slice(1);
   }

   // Find the first slash — everything before is the alias candidate
   const slashIdx = raw.indexOf("/");
   const aliasCandidate = slashIdx === -1 ? raw : raw.slice(0, slashIdx);
   const remainder = slashIdx === -1 ? "" : raw.slice(slashIdx + 1);

   // Exact alias match — only if path separator present (no / = still typing alias, show results)
   if (slashIdx !== -1) {
      const reference = references.find((r) => r.name === aliasCandidate);
      if (reference) {
         return { alias: aliasCandidate, refPath: reference.path, reference, remainder };
      }
   }

   return null;
}

// ─── Fuzzy match (simple subsequence match) ──────────────────────

export function fuzzyMatch(query: string, target: string): boolean {
   const q = query.toLowerCase();
   const t = target.toLowerCase();
   let qi = 0;
   for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) qi++;
   }
   return qi === q.length;
}

// ─── Directory listing for @alias/ browsing ──────────────────────

function listDirectory(dirPath: string, prefix: string): AutocompleteItem[] {
   try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      const items: AutocompleteItem[] = [];

      for (const entry of entries) {
         if (entry.name.startsWith(".")) continue;

         let isDirectory = entry.isDirectory();
         if (!isDirectory && entry.isSymbolicLink()) {
            try {
               isDirectory = statSync(join(dirPath, entry.name)).isDirectory();
            } catch {
               // broken symlink
            }
         }

         const displayPath = prefix ? `${prefix}/${entry.name}` : entry.name;
         const value = isDirectory ? `${displayPath}/` : displayPath;

         items.push({
            value,
            label: entry.name + (isDirectory ? "/" : ""),
            description: isDirectory ? "directory" : "file"
         });
      }

      // Sort: directories first, then alphabetical
      items.sort((a, b) => {
         const aDir = a.label.endsWith("/");
         const bDir = b.label.endsWith("/");
         if (aDir && !bDir) return -1;
         if (!aDir && bDir) return 1;
         return a.label.localeCompare(b.label);
      });

      return items;
   } catch {
      return [];
   }
}

// ─── Provider class ──────────────────────────────────────────────

export class ReferenceAutocompleteProvider implements AutocompleteProvider {
   private wrapped: AutocompleteProvider;
   private getReferences: () => ReferenceInfo[];

   triggerCharacters = ["@"];

   constructor(wrapped: AutocompleteProvider, getReferences: () => ReferenceInfo[]) {
      this.wrapped = wrapped;
      this.getReferences = getReferences;
   }

   async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal; force?: boolean }
   ): Promise<AutocompleteSuggestions | null> {
      const references = this.getReferences();
      const currentLine = lines[cursorLine] || "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const atToken = extractAtToken(textBeforeCursor);

      // Not an active @ token.
      if (!atToken || references.length === 0) {
         // Suppress the built-in fuzzy search if the user just completed a
         // reference alias (e.g. `@opencode-source `) — otherwise the built-in
         // would leak project-file suggestions that have nothing to do with
         // the selected reference.
         if (atToken === null && references.length > 0) {
            const completed = extractCompletedReferenceAlias(textBeforeCursor, references);
            if (completed) return null;
         }
         return this.wrapped.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const parsed = parseReferenceToken(atToken, references);

      if (parsed) {
         // We have @alias or @alias/... — list files in the reference dir
         const suggestions = this.getReferenceFileSuggestions(parsed, atToken);
         if (suggestions) return suggestions;
         // Directory doesn't exist yet (git clone pending). Fall back to built-in.
         return this.wrapped.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      // @partial — no exact alias match yet. Show matching aliases.
      const raw = atToken.startsWith('@"') ? atToken.slice(2) : atToken.slice(1);
      const matching = references.filter((r) => r.name.toLowerCase().startsWith(raw.toLowerCase()));

      if (matching.length === 0) {
         // No alias matches — delegate to built-in for project file fuzzy search
         return this.wrapped.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      // Build alias suggestions
      const items: AutocompleteItem[] = matching.map((ref) => ({
         value: `@${ref.name}/`,
         label: `${CYAN}@${ref.name}${RESET}`,
         description: ref.source.type === "git" ? `git: ${ref.source.repository}` : `local: ${ref.path}`
      }));

      return { items, prefix: atToken };
   }

   private getReferenceFileSuggestions(
      parsed: { alias: string; refPath: string; remainder: string },
      atToken: string
   ): AutocompleteSuggestions | null {
      const { alias, refPath, remainder } = parsed;

      // remainder is the path after alias/ (may be empty or a partial path)
      let searchDir: string;
      let displayPrefix: string;

      if (remainder === "" || remainder.endsWith("/")) {
         // @alias/ or @alias/path/ — list directory contents
         searchDir = remainder ? join(refPath, remainder) : refPath;
         displayPrefix = remainder ? `${alias}/${remainder}`.replace(/\/+$/, "") : alias;
      } else {
         // @alias/path/part — split into dir + file prefix
         const dir = dirname(remainder);
         searchDir = dir === "." ? refPath : join(refPath, dir);
         displayPrefix = dir === "." ? alias : `${alias}/${dir}`;
      }

      try {
         if (!statSync(searchDir).isDirectory()) return null;
      } catch {
         return null;
      }

      let items = listDirectory(searchDir, displayPrefix);

      // If there's a file prefix, filter by it
      if (remainder && !remainder.endsWith("/")) {
         const filePrefix = basename(remainder).toLowerCase();
         items = items.filter((item) => {
            const name = item.label.replace(/\/$/, "").toLowerCase();
            return name.startsWith(filePrefix);
         });
      }

      if (items.length === 0) return null;

      // Build items showing just filenames (path prefix visible in the input bar)
      // Cyan color distinguishes reference files from native autocomplete items.
      const fullItems: AutocompleteItem[] = items.map((item) => {
         const isDir = item.label.endsWith("/");
         const cleanPath = item.value.replace(/\/$/, "");
         return {
            value: `@${cleanPath}${isDir ? "/" : ""}`,
            label: `${CYAN}${item.label}${RESET}`,
            description: item.description
         };
      });

      return { items: fullItems, prefix: atToken };
   }

   applyCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string
   ): { lines: string[]; cursorLine: number; cursorCol: number } {
      // Delegate to wrapped provider for non-@ completions
      if (!prefix.startsWith("@")) {
         return this.wrapped.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }

      // For @ completions, insert item.value (which includes @ prefix).
      // Alias values end with "/" so the dropdown stays open and lists root contents;
      // file values get a trailing space to dismiss the dropdown.
      const currentLine = lines[cursorLine] || "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      const afterCursor = currentLine.slice(cursorCol);

      const endsWithSlash = item.value.endsWith("/");
      const suffix = endsWithSlash ? "" : " ";

      const newLine = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
      const newLines = [...lines];
      newLines[cursorLine] = newLine;

      return {
         lines: newLines,
         cursorLine,
         cursorCol: beforePrefix.length + item.value.length + suffix.length
      };
   }

   shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
      return this.wrapped.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
   }
}

// ─── Input expansion: resolve @alias/path to file content ────────

const MAX_FILE_SIZE = 100 * 1024; // 100KB

/**
 * Expand @alias/path tokens in the submitted text to file content.
 * Returns transformed text with file content injected, or "continue" if no tokens found.
 */
export function expandReferenceTokens(text: string, references: ReferenceInfo[]): string {
   // Sort references longest-first so multi-segment aliases match before short ones
   const sortedRefs = [...references].toSorted((a, b) => b.name.length - a.name.length);
   let hasTransform = false;

   const result = text.replace(/@([^\s`"<>]+)/g, (fullMatch: string, raw: string) => {
      // Try each reference name as a prefix (longest first)
      for (const ref of sortedRefs) {
         const prefix = `${ref.name}/`;
         if (raw === ref.name) {
            // Bare @alias — never expand (directory case)
            return fullMatch;
         }
         if (raw.startsWith(prefix)) {
            const relativePath = raw.slice(prefix.length);
            const fullPath = join(ref.path, relativePath);
            hasTransform = true;

            try {
               const stats = statSync(fullPath);
               if (stats.isDirectory()) {
                  const displayPath = fullPath.replace(/[/\\]+$/, "");
                  return `In "${displayPath}"`;
               }

               if (stats.size > MAX_FILE_SIZE) {
                  return `In "${fullPath}"\n[File too large: ${(stats.size / 1024).toFixed(1)}KB. Use the read tool with offset/limit to read it.]`;
               }

               const content = readFileSync(fullPath, "utf-8");
               return `In "${fullPath}"\n${content}`;
            } catch {
               return `In "${fullPath}"\n[File not found or not readable]`;
            }
         }
      }
      return fullMatch;
   });

   return hasTransform ? result : text;
}
