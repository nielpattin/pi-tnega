import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

function tokenizeShell(command: string): string[] {
   return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function stripQuotes(token: string): string {
   if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
   }
   return token;
}

function isOptionToken(token: string): boolean {
   return token.startsWith("-");
}

function isCommandSeparator(token: string): boolean {
   return token === "&&" || token === "||" || token === ";" || token === "|";
}

function isDangerousRootLikePath(token: string): boolean {
   const normalized = token.replace(/\\/g, "/");
   return (
      normalized === "." ||
      normalized === "./" ||
      normalized === "/" ||
      normalized === "~" ||
      /^[A-Za-z]:\/?$/.test(normalized) ||
      /^[A-Za-z]:\/Users\/?[^/]*\/?$/.test(normalized)
   );
}

function hasScopeFlag(tokens: string[]): boolean {
   return tokens.some((token, index) => {
      const value = stripQuotes(token);
      if (value === "-g" || value === "--glob" || value === "-t" || value === "--type") {
         return index + 1 < tokens.length;
      }
      return value.startsWith("-g") || value.startsWith("--glob=") || value.startsWith("-t");
   });
}

function findUnsafeRgReason(command: string): string | null {
   const rawTokens = tokenizeShell(command);
   const tokens = rawTokens.map(stripQuotes);

   for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== "rg") continue;

      const segment: string[] = [];
      for (let j = i; j < tokens.length; j++) {
         const token = tokens[j]!;
         if (j > i && isCommandSeparator(token)) break;
         segment.push(token);
      }

      const positional: string[] = [];
      for (let j = 1; j < segment.length; j++) {
         const token = segment[j]!;
         if (isOptionToken(token)) {
            const previous = segment[j - 1];
            if (previous === "-g" || previous === "--glob" || previous === "-t" || previous === "--type") {
               continue;
            }
            if (token === "-g" || token === "--glob" || token === "-t" || token === "--type") {
               j++;
            }
            continue;
         }
         positional.push(token);
      }

      const pathArgs = positional.slice(1);
      if (pathArgs.some(isDangerousRootLikePath)) {
         return "rg targets a repo root, home directory, or filesystem root";
      }

      if (pathArgs.length === 0 && !hasScopeFlag(segment)) {
         return "rg has no explicit path or glob restriction";
      }
   }

   return null;
}

export default function (pi: ExtensionAPI) {
   pi.on("tool_call", async (event) => {
      if (!isToolCallEventType("bash", event)) return;

      const command = event.input.command;
      if (!command || !/\brg\b/.test(command)) return;

      const reason = findUnsafeRgReason(command);
      if (!reason) return;

      return {
         block: true,
         reason:
            `Blocked unsafe rg command (${reason}). ` +
            `Use rg only with a narrow path or explicit glob/type filter. ` +
            `Do not search from '.', '/', '~', or a drive root. ` +
            `Prefer ls/find/read first, then run a scoped rg like 'rg -n "pattern" src' or 'rg -n -g "*.ts" "pattern"'.`,
      };
   });
}
