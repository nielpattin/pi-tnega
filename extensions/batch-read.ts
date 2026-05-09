import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

interface FileEntry {
   path: string;
   offset?: number;
   limit?: number;
}

function asksForChunkedRead(prompt: string) {
   return /\b(chunk|chunks|chunked|incremental|incrementally|range|ranges|offset|offsets)\b/i.test(prompt);
}

function readPath(input: Record<string, unknown>) {
   const path = input.path ?? input.file_path;
   return typeof path === "string" ? path : undefined;
}

function hasReadRange(input: Record<string, unknown>) {
   return input.offset !== undefined || input.limit !== undefined;
}

export default function batchReadExtension(pi: ExtensionAPI) {
   let forceBatchReadForCurrentPrompt = false;
   let readsByPath = new Map<string, { count: number; ranged: boolean }>();

   pi.on("before_agent_start", async (event) => {
      forceBatchReadForCurrentPrompt = asksForChunkedRead(event.prompt);
      readsByPath = new Map();
   });

   pi.on("tool_call", async (event) => {
      if (event.toolName !== "read") return;

      const path = readPath(event.input);
      const ranged = hasReadRange(event.input);
      const previous = path ? readsByPath.get(path) : undefined;
      const repeatedChunkRead = !!path && !!previous && (ranged || previous.ranged);

      if (forceBatchReadForCurrentPrompt || repeatedChunkRead) {
         return {
            block: true,
            reason:
               "Use batch_read instead of multiple read calls for chunked or repeated same-file reads. Put the chunks in one batch_read call, for example [{ path, offset: 1, limit: 500 }, { path, offset: 501, limit: 500 }, { path, offset: 1001, limit: 500 }]. A single read is fine when the file fits in one result.",
         };
      }

      if (path) {
         readsByPath.set(path, {
            count: (previous?.count ?? 0) + 1,
            ranged: (previous?.ranged ?? false) || ranged,
         });
      }
   });

   pi.registerTool({
      name: "batch_read",
      label: "batch read",
      description:
         "Read one or more text files, or multiple chunks of the same large file, in a single call. Prefer this over multiple sequential read calls whenever you need more than one file range. Each file entry has its own 1-indexed offset and limit. Example chunked read in one request: [{ path: 'index.ts', offset: 1, limit: 500 }, { path: 'index.ts', offset: 501, limit: 500 }, { path: 'index.ts', offset: 1001, limit: 500 }]. Returns contents separated by path headers.",
      promptSnippet: "Read multiple files or multiple chunks in one call, preferred over repeated read calls",
      promptGuidelines: [
         "Before reading many files or chunking large files, inspect file sizes and line counts first. Use `ls -la <dir>` for sizes, then run `wc -l <files>` to get LOC before choosing read, batch_read, or chunked batch_read. pi-rtk will rewrite both commands to compact RTK output when enabled.",
         "When reading multiple source files, run `wc -l <files>` before batch_read so you can choose full reads, samples, or chunk ranges based on line counts.",
         "Prefer batch_read over multiple sequential read calls whenever you need to read more than one file range.",
         "If you are about to call read with offset/limit multiple times, stop and use one batch_read call with multiple entries instead.",
         "Use batch_read to incrementally read a large file in chunks in one round trip, for example index.ts offset 1 limit 500, index.ts offset 501 limit 500, index.ts offset 1001 limit 500.",
         "Offsets are 1-indexed line numbers. Each file entry has its own offset and limit, so one batch can read different files, different ranges, or repeated ranges from the same file.",
      ],
      parameters: Type.Object({
         files: Type.Array(
            Type.Object({
               path: Type.String({ description: "File path to read" }),
               offset: Type.Optional(Type.Number({ description: "Start line (1-indexed)" })),
               limit: Type.Optional(Type.Number({ description: "Max lines" })),
            }),
            { description: "Files to read with optional per-file offset/limit" },
         ),
      }),

      renderCall(_args, theme) {
         return new Text(theme.fg("toolTitle", theme.bold("batch read")), 0, 0);
      },

      renderResult(result, _opts, theme, context) {
         const files = (context.args as { files: FileEntry[] }).files;
         const lines: string[] = files.map((f) => {
            const hasRange = f.offset !== undefined || f.limit !== undefined;
            const range = hasRange
               ? theme.fg(
                    "muted",
                    `:${f.offset ?? 1}${f.limit !== undefined ? "-" + ((f.offset ?? 1) + f.limit - 1) : ""}`,
                 )
               : "";
            return `  ${theme.fg("accent", f.path)}${range}`;
         });

         const text = result.content.find((c) => c.type === "text");
         if (text && text.type === "text") {
            const fileCount = (text.text.match(/^--- /gm) || []).length;
            const lineCount = text.text.split("\n").length;
            lines.push(theme.fg("muted", `  ${fileCount} files, ${lineCount} lines`));
         }

         return new Text(lines.join("\n"), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
         const files = params.files as FileEntry[];
         const cwd = ctx.cwd;
         const sections: string[] = [];

         for (const file of files) {
            const absolute = resolve(cwd, file.path);
            const display = relative(cwd, absolute) || file.path;

            try {
               let content = await readFile(absolute, "utf8");

               if (file.offset !== undefined || file.limit !== undefined) {
                  const lines = content.split("\n");
                  const start = (file.offset ?? 1) - 1;
                  const end = file.limit !== undefined ? start + file.limit : lines.length;
                  content = lines.slice(start, end).join("\n");
               }

               sections.push(`--- ${display} ---\n${content}`);
            } catch (err: any) {
               sections.push(`--- ${display} ---\n[error: ${err.code === "ENOENT" ? "file not found" : err.message}]`);
            }
         }

         return {
            content: [{ type: "text" as const, text: sections.join("\n\n") }],
            details: undefined,
         };
      },
   });
}
