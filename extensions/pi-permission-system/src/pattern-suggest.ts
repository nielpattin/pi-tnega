import { prefix } from "./bash-arity";
import { PATH_BEARING_TOOLS } from "./path-utils";
import { deriveApprovalPattern } from "./session-rules";

/** The suggestion returned for a "Yes, for this session" dialog option. */
export interface SessionApprovalSuggestion {
   /** The permission surface this approval applies to. */
   surface: string;
   /** The wildcard pattern to store as a session rule. Empty when `suppress`. */
   pattern: string;
   /** Human-readable label for the "for session" dialog option. Empty when `suppress`. */
   label: string;
   /**
    * When true, no safe session pattern exists — the "for this session" dialog
    * option should be hidden, forcing a one-off Yes/No decision.
    */
   suppress?: boolean;
}

/**
 * Regex matching shell control operators that join commands into a chain.
 * Matches `&&`, `||`, `;`, `|` (pipe), and a bare `&` (background) that is
 * not part of a redirect like `2>&1` (excluded via the `(?<![<>])` lookbehind).
 */
const SHELL_OPERATOR_RE = /&&|\|\||;|\||(?<![<>])&/;

/**
 * Detect whether a command string contains a shell control operator that
 * chains multiple commands (`&&`, `||`, `;`, `|`, `&`).
 */
export function hasShellOperator(command: string): boolean {
   return SHELL_OPERATOR_RE.test(command);
}

/**
 * Suggest a bash session-approval pattern from a command string.
 *
 * Uses the arity table (`src/bash-arity.ts`) to identify the semantically
 * meaningful prefix tokens for the command, then produces a wildcard pattern:
 *
 * - Single bare token (no args): exact command (`ls`).
 * - Arity prefix covers all tokens: trailing wildcard (`npm run build*`).
 * - Arity prefix shorter than token list: space + wildcard (`git checkout *`).
 * - Unknown command: first token + space wildcard (`mytool *`).
 *
 * Chained commands (containing `&&`, `||`, `;`, `|`, `&`) are handled
 * specially: a first-token pattern (e.g. `cd *`) would whitelabel the benign
 * prefix and silently approve arbitrary chains via the trailing-`*` optional
 * match. Instead, the matched rule pattern is used when it is specific, and
 * the session option is suppressed (empty return) otherwise.
 *
 * @param command       The raw command string.
 * @param matchedPattern The wildcard pattern of the rule that triggered the
 *                       prompt, if any. Used for chained commands.
 * @returns The suggested pattern, or empty string to suppress the session option.
 */
export function suggestBashPattern(command: string, matchedPattern?: string): string {
   const trimmed = command.trim();
   if (!trimmed) return "";

   if (hasShellOperator(trimmed)) {
      // Chained command: derive the session pattern from the matched rule so
      // the approval reflects the operation that triggered the prompt. A
      // catch-all (`*`) or absent match gives no safe pattern, so suppress.
      if (matchedPattern && matchedPattern !== "*") return matchedPattern;
      return "";
   }

   const tokens = trimmed.split(/\s+/);
   if (tokens.length === 1) return trimmed;
   const meaningful = prefix(tokens);
   if (meaningful.length >= tokens.length) {
      return `${trimmed}*`;
   }
   return `${meaningful.join(" ")} *`;
}

/**
 * Suggest an MCP session-approval pattern from a resolved target string.
 *
 * - Qualified target (`server:tool`) → `server:*`
 * - Munged target (`server_tool`) → `server_*`
 * - Bare target (no separator) → `*`
 */
export function suggestMcpPattern(target: string): string {
   const trimmed = target.trim();

   const colonIndex = trimmed.indexOf(":");
   if (colonIndex > 0) {
      return `${trimmed.slice(0, colonIndex)}:*`;
   }

   const underscoreIndex = trimmed.indexOf("_");
   if (underscoreIndex > 0) {
      return `${trimmed.slice(0, underscoreIndex)}_*`;
   }

   return "*";
}

/** Surface-aware human-readable labels for the session-approval option. */
function buildLabel(pattern: string, surface: string): string {
   switch (surface) {
      case "bash":
         return `Yes, allow bash "${pattern}" for this session`;
      case "mcp":
         return `Yes, allow mcp tool "${pattern}" for this session`;
      case "skill":
         return `Yes, allow skill "${pattern}" for this session`;
      case "external_directory":
         return `Yes, allow access to external directory "${pattern}" for this session`;
      case "path":
         return `Yes, allow path "${pattern}" for this session`;
      default:
         // Path-bearing tools with a specific path pattern show the pattern.
         if (PATH_BEARING_TOOLS.has(surface) && pattern !== "*") {
            return `Yes, allow ${surface} "${pattern}" for this session`;
         }
         // Tool surfaces with catch-all or extension tools.
         return `Yes, allow tool "${surface}" for this session`;
   }
}

/**
 * Suggest a session-approval pattern for the given permission surface and value.
 *
 * Returns a `SessionApprovalSuggestion` with the surface, the wildcard pattern
 * to store in `SessionRules`, and a human-readable dialog label.
 */
export function suggestSessionPattern(
   surface: string,
   value: string,
   matchedPattern?: string,
   cwd?: string
): SessionApprovalSuggestion {
   let pattern: string;
   let suppress = false;
   const effectiveCwd = cwd ?? process.cwd();

   switch (surface) {
      case "bash":
         pattern = suggestBashPattern(value, matchedPattern);
         if (pattern === "") suppress = true;
         break;
      case "mcp":
         pattern = suggestMcpPattern(value);
         break;
      case "skill":
         pattern = value;
         break;
      case "external_directory":
         pattern = deriveApprovalPattern(value, effectiveCwd);
         break;
      case "path":
         pattern = deriveApprovalPattern(value, effectiveCwd);
         break;
      default:
         // Path-bearing tools: derive a directory-scoped pattern from the path.
         if (PATH_BEARING_TOOLS.has(surface) && value !== "*") {
            pattern = deriveApprovalPattern(value, effectiveCwd);
            break;
         }
         // Extension tools / fallback.
         pattern = "*";
         break;
   }

   if (suppress) {
      return { surface, pattern: "", label: "", suppress: true };
   }

   return { surface, pattern, label: buildLabel(pattern, surface) };
}
