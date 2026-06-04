/**
 * 🌸 Cute Minimal Mode - Playful tool display with fuzzy resolution
 *
 * Overrides all built-in tool renderers with cute, compact output:
 * - Collapsed: emoji badge + tool name + playful status suffix
 * - Expanded: full output
 *
 * read and grep also include pi-fff's fuzzy path resolution via
 * FffRuntime, so pi-fff can safely fail to load without losing
 * any functionality.
 *
 * Usage:
 *   pi -e ./cute-minimal-mode.ts
 *
 * Toggle collapsed/expanded with ctrl+o.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
   createBashTool,
   createEditTool,
   createFindTool,
   createGrepTool,
   createLsTool,
   createReadTool,
   createWriteTool
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Fuzzy resolution: try to import pi-fff's runtime at load time.
// If pi-fff is installed, we get fuzzy path resolution for read/grep.
// If not, tools fall back to built-in behavior gracefully.
// ---------------------------------------------------------------------------
let FffRuntimeClass: any = null;
try {
   // @ts-expect-error pi-fff internal import, resolved at runtime by jiti
   const mod = await import("pi-fff/src/fff.ts");
   FffRuntimeClass = mod.FffRuntime;
} catch {
   // pi-fff not available — tools will use basic behavior
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function shortenPath(path: string): string {
   const home = homedir();
   if (path.startsWith(home)) {
      return `~${path.slice(home.length)}`;
   }
   return path;
}

const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
   return {
      bash: createBashTool(cwd),
      edit: createEditTool(cwd),
      write: createWriteTool(cwd),
      find: createFindTool(cwd),
      grep: createGrepTool(cwd),
      ls: createLsTool(cwd),
      read: createReadTool(cwd)
   };
}

function getBuiltInTools(cwd: string) {
   let tools = toolCache.get(cwd);
   if (!tools) {
      tools = createBuiltInTools(cwd);
      toolCache.set(cwd, tools);
   }
   return tools;
}

// Cute badges per tool
const badges: Record<string, string> = {
   read: "📖",
   bash: "⚡",
   write: "✏️",
   edit: "🔧",
   find: "🔍",
   grep: "🔎",
   ls: "📂"
};

// Playful collapsed-mode status lines
const resultSuffixes: Record<string, string> = {
   read: "got it!",
   bash: "donezo!",
   write: "saved!",
   edit: "snipped!",
   find: "found some!",
   grep: "spotted!",
   ls: "peeked!"
};

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default async function (pi: ExtensionAPI) {
   // --- Fuzzy runtime lifecycle -------------------------------------------
   let runtime: any = null;

   if (FffRuntimeClass) {
      try {
         runtime = new FffRuntimeClass(process.cwd());
      } catch {
         runtime = null;
      }
   }

   pi.on("session_start", async (_event, ctx) => {
      if (!FffRuntimeClass) return;
      try {
         runtime = new FffRuntimeClass(ctx.cwd);
      } catch {
         runtime = null;
      }
   });

   pi.on("session_shutdown", async () => {
      runtime?.dispose();
      runtime = null;
   });

   // =====================================================================
   // Read Tool  (fuzzy resolution + cute rendering)
   // =====================================================================
   pi.registerTool({
      name: "read",
      label: "read",
      description:
         "Read the contents of a file with fuzzy path resolution. Supports text files and images (jpg, png, gif, webp).",
      parameters: getBuiltInTools(process.cwd()).read.parameters,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
         const original = createReadTool(ctx.cwd);

         if (!runtime) {
            return original.execute(toolCallId, params, signal, onUpdate);
         }

         try {
            const resolution = await runtime.resolvePath(params.path, {
               allowDirectory: false,
               limit: 8
            });
            return resolution.match({
               err: async () => original.execute(toolCallId, params, signal, onUpdate),
               ok: async (resolved: any) =>
                  original.execute(toolCallId, { ...params, path: resolved.absolutePath }, signal, onUpdate)
            });
         } catch {
            return original.execute(toolCallId, params, signal, onUpdate);
         }
      },

      renderCall(args, theme, _context) {
         const path = shortenPath(args.path || "");
         let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "??");

         if (args.offset !== undefined || args.limit !== undefined) {
            const startLine = args.offset ?? 1;
            const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
            pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
         }

         return new Text(`${theme.fg("toolTitle", theme.bold(`${badges.read} read`))} ${pathDisplay}`, 0, 0);
      },

      renderResult(result, { expanded }, theme, _context) {
         if (!expanded) {
            return new Text(theme.fg("muted", `  ${resultSuffixes.read}`), 0, 0);
         }

         const textContent = result.content.find((c) => c.type === "text");
         if (textContent?.type !== "text") {
            return new Text("", 0, 0);
         }

         const lines = textContent.text.split("\n");
         const output = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
         return new Text(`\n${output}`, 0, 0);
      }
   });

   // =====================================================================
   // Bash Tool
   // =====================================================================
   pi.registerTool({
      name: "bash",
      label: "bash",
      description: "Execute a bash command in the current working directory. Returns stdout and stderr.",
      parameters: getBuiltInTools(process.cwd()).bash.parameters,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
         const tools = getBuiltInTools(ctx.cwd);
         return tools.bash.execute(toolCallId, params, signal, onUpdate);
      },

      renderCall(args, theme, _context) {
         const command = args.command || "??";
         const timeout = args.timeout;
         const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

         return new Text(theme.fg("toolTitle", theme.bold(`${badges.bash} $ ${command}`)) + timeoutSuffix, 0, 0);
      },

      renderResult(result, { expanded }, theme, _context) {
         if (!expanded) {
            return new Text(theme.fg("muted", `  ${resultSuffixes.bash}`), 0, 0);
         }

         const textContent = result.content.find((c) => c.type === "text");
         if (textContent?.type !== "text") {
            return new Text("", 0, 0);
         }

         const output = textContent.text
            .trim()
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n");

         if (!output) return new Text("", 0, 0);
         return new Text(`\n${output}`, 0, 0);
      }
   });

   // =====================================================================
   // Write Tool
   // =====================================================================
   pi.registerTool({
      name: "write",
      label: "write",
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
      parameters: getBuiltInTools(process.cwd()).write.parameters,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
         const tools = getBuiltInTools(ctx.cwd);
         return tools.write.execute(toolCallId, params, signal, onUpdate);
      },

      renderCall(args, theme, _context) {
         const path = shortenPath(args.path || "");
         const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "??");
         const lineCount = args.content ? args.content.split("\n").length : 0;
         const lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} lines)`) : "";

         return new Text(
            `${theme.fg("toolTitle", theme.bold(`${badges.write} write`))} ${pathDisplay}${lineInfo}`,
            0,
            0
         );
      },

      renderResult(result, { expanded }, theme, _context) {
         if (!expanded) {
            return new Text(theme.fg("muted", `  ${resultSuffixes.write}`), 0, 0);
         }

         if (result.content.some((c) => c.type === "text" && c.text)) {
            const textContent = result.content.find((c) => c.type === "text");
            if (textContent?.type === "text" && textContent.text) {
               return new Text(`\n${theme.fg("error", textContent.text)}`, 0, 0);
            }
         }

         return new Text("", 0, 0);
      }
   });

   // =====================================================================
   // Edit Tool
   // =====================================================================
   pi.registerTool({
      name: "edit",
      label: "edit",
      description: "Edit a file by replacing exact text. The oldText must match exactly (including whitespace).",
      parameters: getBuiltInTools(process.cwd()).edit.parameters,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
         const tools = getBuiltInTools(ctx.cwd);
         return tools.edit.execute(toolCallId, params, signal, onUpdate);
      },

      renderCall(args, theme, _context) {
         const path = shortenPath(args.path || "");
         const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "??");

         return new Text(`${theme.fg("toolTitle", theme.bold(`${badges.edit} edit`))} ${pathDisplay}`, 0, 0);
      },

      renderResult(result, { expanded }, theme, _context) {
         if (!expanded) {
            return new Text(theme.fg("muted", `  ${resultSuffixes.edit}`), 0, 0);
         }

         const textContent = result.content.find((c) => c.type === "text");
         if (textContent?.type !== "text") {
            return new Text("", 0, 0);
         }

         const text = textContent.text;
         if (text.includes("Error") || text.includes("error")) {
            return new Text(`\n${theme.fg("error", text)}`, 0, 0);
         }

         return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);
      }
   });

   // =====================================================================
   // Find Tool
   // =====================================================================
   pi.registerTool({
      name: "find",
      label: "find",
      description: "Find files by name pattern (glob). Searches recursively from the specified path.",
      parameters: getBuiltInTools(process.cwd()).find.parameters,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
         const tools = getBuiltInTools(ctx.cwd);
         return tools.find.execute(toolCallId, params, signal, onUpdate);
      },

      renderCall(args, theme, _context) {
         const pattern = args.pattern || "";
         const path = shortenPath(args.path || ".");
         const limit = args.limit;

         let text = `${theme.fg("toolTitle", theme.bold(`${badges.find} find`))} ${theme.fg("accent", pattern)}`;
         text += theme.fg("toolOutput", ` in ${path}`);
         if (limit !== undefined) {
            text += theme.fg("toolOutput", ` (limit ${limit})`);
         }

         return new Text(text, 0, 0);
      },

      renderResult(result, { expanded }, theme, _context) {
         const textContent = result.content.find((c) => c.type === "text");
         if (textContent?.type === "text") {
            const count = textContent.text.trim().split("\n").filter(Boolean).length;

            if (!expanded) {
               if (count > 0) {
                  return new Text(theme.fg("muted", `  ${resultSuffixes.find} ${count} files`), 0, 0);
               }
               return new Text(theme.fg("muted", `  nothing here!`), 0, 0);
            }

            if (count > 0) {
               const output = textContent.text
                  .trim()
                  .split("\n")
                  .map((line) => theme.fg("toolOutput", line))
                  .join("\n");
               return new Text(`\n${output}`, 0, 0);
            }
         }

         return new Text("", 0, 0);
      }
   });

   // =====================================================================
   // Grep Tool  (fuzzy search + cute rendering)
   // =====================================================================
   pi.registerTool({
      name: "grep",
      label: "grep",
      description: "Search file contents with fuzzy path scope resolution. Uses ripgrep for fast searching.",
      parameters: getBuiltInTools(process.cwd()).grep.parameters,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
         const original = createGrepTool(ctx.cwd);

         if (!runtime) {
            return original.execute(toolCallId, params, signal, onUpdate);
         }

         try {
            const result = await runtime.grepSearch({
               pattern: params.pattern,
               pathQuery: params.path,
               glob: params.glob,
               context: params.context,
               limit: params.limit
            });

            return result.match({
               err: async () => original.execute(toolCallId, params, signal, onUpdate),
               ok: async (value: any) => ({
                  content: [{ type: "text" as const, text: value.formatted }],
                  details: { fff: true }
               })
            });
         } catch {
            return original.execute(toolCallId, params, signal, onUpdate);
         }
      },

      renderCall(args, theme, _context) {
         const pattern = args.pattern || "";
         const path = shortenPath(args.path || ".");
         const glob = args.glob;
         const limit = args.limit;

         let text = `${theme.fg("toolTitle", theme.bold(`${badges.grep} grep`))} ${theme.fg("accent", `/${pattern}/`)}`;
         text += theme.fg("toolOutput", ` in ${path}`);
         if (glob) text += theme.fg("toolOutput", ` (${glob})`);
         if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);

         return new Text(text, 0, 0);
      },

      renderResult(result, { expanded }, theme, _context) {
         const textContent = result.content.find((c) => c.type === "text");
         if (textContent?.type === "text") {
            const count = textContent.text.trim().split("\n").filter(Boolean).length;

            if (!expanded) {
               if (count > 0) {
                  return new Text(theme.fg("muted", `  ${resultSuffixes.grep} ${count} matches`), 0, 0);
               }
               return new Text(theme.fg("muted", `  nope, nada!`), 0, 0);
            }

            if (count > 0) {
               const output = textContent.text
                  .trim()
                  .split("\n")
                  .map((line) => theme.fg("toolOutput", line))
                  .join("\n");
               return new Text(`\n${output}`, 0, 0);
            }
         }

         return new Text("", 0, 0);
      }
   });

   // =====================================================================
   // Ls Tool
   // =====================================================================
   pi.registerTool({
      name: "ls",
      label: "ls",
      description: "List directory contents with file sizes. Shows files and directories with their sizes.",
      parameters: getBuiltInTools(process.cwd()).ls.parameters,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
         const tools = getBuiltInTools(ctx.cwd);
         return tools.ls.execute(toolCallId, params, signal, onUpdate);
      },

      renderCall(args, theme, _context) {
         const path = shortenPath(args.path || ".");
         const limit = args.limit;

         let text = `${theme.fg("toolTitle", theme.bold(`${badges.ls} ls`))} ${theme.fg("accent", path)}`;
         if (limit !== undefined) {
            text += theme.fg("toolOutput", ` (limit ${limit})`);
         }

         return new Text(text, 0, 0);
      },

      renderResult(result, { expanded }, theme, _context) {
         const textContent = result.content.find((c) => c.type === "text");
         if (textContent?.type === "text") {
            const count = textContent.text.trim().split("\n").filter(Boolean).length;

            if (!expanded) {
               if (count > 0) {
                  return new Text(theme.fg("muted", `  ${resultSuffixes.ls} ${count} things`), 0, 0);
               }
               return new Text(theme.fg("muted", `  empty!`), 0, 0);
            }

            if (count > 0) {
               const output = textContent.text
                  .trim()
                  .split("\n")
                  .map((line) => theme.fg("toolOutput", line))
                  .join("\n");
               return new Text(`\n${output}`, 0, 0);
            }
         }

         return new Text("", 0, 0);
      }
   });
}
