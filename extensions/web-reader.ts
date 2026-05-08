import * as https from "node:https";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	keyHint,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

type WebReaderParams = {
	url: string;
	base?: string;
	tokenBudget?: number;
	withImagesSummary?: string;
};

type JinaResult = {
	statusCode: number;
	statusMessage?: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
};

type WebReaderDetails = {
	url: string;
	statusCode: number;
	base: string;
	tokenBudget: number;
	withImagesSummary: string;
	truncated: boolean;
	fullOutputPath?: string;
};

function formatUrlForDisplay(input: string, maxLength = 52): string {
	try {
		const url = new URL(input);
		const path = `${url.pathname}${url.search}` || "/";
		const value = `${url.hostname}${path}`;
		return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
	} catch {
		return input.length > maxLength ? `${input.slice(0, maxLength - 3)}...` : input;
	}
}

function postToJina(apiKey: string, params: WebReaderParams, signal?: AbortSignal): Promise<JinaResult> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify({ url: params.url });

		const req = https.request(
			{
				hostname: "r.jina.ai",
				path: "/",
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"X-Base": params.base ?? "final",
					"X-Token-Budget": String(params.tokenBudget ?? 50000),
					"X-With-Images-Summary": params.withImagesSummary ?? "all",
				},
			},
			(res) => {
				let responseData = "";

				res.on("data", (chunk) => {
					responseData += chunk;
				});

				res.on("end", () => {
					cleanup();
					resolve({
						statusCode: res.statusCode ?? 0,
						statusMessage: res.statusMessage,
						headers: res.headers,
						body: responseData,
					});
				});

				res.on("error", (err) => {
					cleanup();
					reject(err);
				});
			},
		);

		const onAbort = () => {
			req.destroy(new Error("Request aborted"));
		};

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
		};

		if (signal) {
			if (signal.aborted) {
				reject(new Error("Request aborted"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		req.on("error", (err) => {
			cleanup();
			reject(err);
		});

		req.write(payload);
		req.end();
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_reader",
		label: "Web Reader",
		description: `Read a web page through Jina Reader and return extracted text/markdown. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Fetch and extract readable content from a web page URL",
		promptGuidelines: ["Use web_reader when the user wants the contents of a public web page."],
		parameters: Type.Object({
			url: Type.String({ description: "Public URL to read" }),
			base: Type.Optional(Type.String({ description: "X-Base header. Default: final" })),
			tokenBudget: Type.Optional(Type.Number({ description: "X-Token-Budget header. Default: 20000" })),
			withImagesSummary: Type.Optional(Type.String({ description: "X-With-Images-Summary header. Default: all" })),
		}),

		async execute(_toolCallId, params, signal) {
			const apiKey = process.env.JINA_API_KEY;
			if (!apiKey) {
				throw new Error("JINA_API_KEY is not set");
			}

			const result = await postToJina(apiKey, params, signal);

			if (result.statusCode >= 400) {
				throw new Error(`Jina request failed: ${result.statusCode} ${result.statusMessage ?? ""}\n${result.body}`);
			}

			const truncation = truncateHead(result.body, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let text = truncation.content;
			let fullOutputPath: string | undefined;

			if (truncation.truncated) {
				const dir = await mkdtemp(join(tmpdir(), "pi-web-reader-"));
				fullOutputPath = join(dir, "response.md");

				await withFileMutationQueue(fullOutputPath, async () => {
					await writeFile(fullOutputPath!, result.body, "utf8");
				});

				text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					url: params.url,
					statusCode: result.statusCode,
					base: params.base ?? "final",
					tokenBudget: params.tokenBudget ?? 20000,
					withImagesSummary: params.withImagesSummary ?? "all",
					truncated: truncation.truncated,
					fullOutputPath,
				} satisfies WebReaderDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_reader "));
			text += theme.fg("accent", formatUrlForDisplay(args.url));
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Reading page..."), 0, 0);
			}

			if (!expanded) {
				return new Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")), 0, 0);
			}

			const details = result.details as WebReaderDetails | undefined;
			const content = result.content.find((item) => item.type === "text");
			const lines: string[] = [];

			if (details?.url) {
				lines.push(theme.fg("accent", details.url));
			}

			if (details) {
				lines.push(
					theme.fg(
						"dim",
						`base=${details.base} tokenBudget=${details.tokenBudget} images=${details.withImagesSummary}`,
					),
				);
			}

			if (details?.fullOutputPath) {
				lines.push(theme.fg("muted", `full output: ${details.fullOutputPath}`));
			}

			if (content?.type === "text") {
				if (lines.length > 0) lines.push("");
				lines.push(content.text);
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
