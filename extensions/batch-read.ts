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

export default function batchReadExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "batch_read",
		label: "batch read",
		description:
			"Read multiple files in a single call with per-file offset/limit. Returns contents separated by path headers.",
		promptSnippet: "Read multiple files at once",
		promptGuidelines: ["Use batch_read when you need to read several files to reduce tool call round-trips."],
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
