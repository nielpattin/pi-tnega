import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";

import type { ExtensionConfig } from "./config.js";
import type { DebugLogger } from "./debug-logger.js";

interface CommandCodeRuntimeState {
	cwd?: string;
}

interface CommandCodeContentPart {
	type: string;
	text?: string;
	image?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
	arguments?: unknown;
	toolCallId?: string;
	toolName?: string;
	output?: { type: "text" | "error-text"; value: string };
	isError?: boolean;
}

interface CommandCodeMessage {
	role: "user" | "assistant" | "tool";
	content: string | CommandCodeContentPart[];
}

interface CommandCodeTool {
	name: string;
	description: string;
	input_schema: unknown;
}

interface CommandCodeRequest {
	memory: string;
	taste: null;
	skills: string;
	params: {
		tools?: CommandCodeTool[];
		stream: true;
		max_tokens: number;
		temperature?: number;
		system?: string;
		messages: CommandCodeMessage[];
		model: string;
	};
	config: Record<string, unknown>;
}

interface CommandCodeResponse {
	id?: unknown;
	role?: unknown;
	model?: unknown;
	content?: unknown;
	stop_reason?: unknown;
	usage?: unknown;
	error?: unknown;
	message?: unknown;
}

type ParsedContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; toolCall: ToolCall };

interface ToolInputAccumulator {
	id: string;
	toolName: string;
	inputText: string;
}

const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const API_MAX_OUTPUT_TOKENS = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nowDate(): string {
	return new Date().toISOString().slice(0, 10);
}

function buildCommandConfig(runtime: CommandCodeRuntimeState): Record<string, unknown> {
	return {
		workingDir: runtime.cwd ?? "",
		date: nowDate(),
		environment: `${process.platform}-${process.arch}, Node ${process.version}`,
		structure: [],
		isGitRepo: false,
		currentBranch: "",
		mainBranch: "main",
		gitStatus: "",
		recentCommits: [],
	};
}

function textPart(text: string): CommandCodeContentPart {
	return { type: "text", text };
}

function imagePlaceholder(_image: ImageContent): CommandCodeContentPart {
	return textPart("[image omitted]");
}

function textFromContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? part.text : "[image omitted]")).join("");
}

function userContent(content: string | (TextContent | ImageContent)[]): string | CommandCodeContentPart[] {
	if (typeof content === "string") return content;
	const parts = content.map((part) => (part.type === "text" ? textPart(part.text) : imagePlaceholder(part)));
	if (parts.length === 1 && parts[0].type === "text") return parts[0].text ?? "";
	return parts.length > 0 ? parts : "";
}

function assistantContent(message: AssistantMessage): string | CommandCodeContentPart[] {
	const parts: CommandCodeContentPart[] = [];
	for (const part of message.content) {
		if (part.type === "text") {
			parts.push(textPart(part.text));
		} else if (part.type === "thinking") {
			parts.push({ type: "reasoning", text: part.thinking });
		} else if (part.type === "toolCall") {
			parts.push({
				type: "tool-call",
				toolCallId: part.id,
				toolName: part.name,
				input: part.arguments ?? {},
			});
		}
	}
	if (parts.length === 1 && parts[0].type === "text") return parts[0].text ?? "";
	return parts.length > 0 ? parts : "";
}

function toolResultContent(
	message: Extract<Context["messages"][number], { role: "toolResult" }>,
): CommandCodeContentPart[] {
	return [
		{
			type: "tool-result",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			output: {
				type: message.isError ? "error-text" : "text",
				value: textFromContent(message.content),
			},
		},
	];
}

function buildMessages(context: Context): CommandCodeMessage[] {
	const messages: CommandCodeMessage[] = [];
	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ role: "user", content: userContent(message.content) });
		} else if (message.role === "assistant") {
			messages.push({ role: "assistant", content: assistantContent(message) });
		} else if (message.role === "toolResult") {
			messages.push({ role: "tool", content: toolResultContent(message) });
		}
	}
	return messages.length > 0 ? messages : [{ role: "user", content: "" }];
}

function toolSchemaForRequest(tool: Tool): unknown {
	return tool.parameters ?? { type: "object", properties: {} };
}

function sanitizeToolVocabulary(text: string): string {
	return text
		.replace(/\bglob\s+patterns\b/gi, "file patterns")
		.replace(/\bglob\s+pattern\b/gi, "file pattern")
		.replace(/\bglob\b/gi, "file pattern");
}

function sanitizeSchemaKey(key: string): string {
	return key === "glob" ? "filePattern" : key;
}

function sanitizeOutboundValue(value: unknown): unknown {
	if (typeof value === "string") return value === "glob" ? "filePattern" : sanitizeToolVocabulary(value);
	if (Array.isArray(value)) return value.map((entry) => sanitizeOutboundValue(entry));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [sanitizeSchemaKey(key), sanitizeOutboundValue(entry)]),
	);
}

function buildTools(tools: Tool[] | undefined): CommandCodeTool[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		name: tool.name,
		description: sanitizeToolVocabulary(tool.description),
		input_schema: sanitizeOutboundValue(toolSchemaForRequest(tool)),
	}));
}

function buildSystemPrompt(config: ExtensionConfig, context: Context): string | undefined {
	const prompt = [config.memory, context.systemPrompt]
		.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		.join("\n\n")
		.trim();
	return prompt.length > 0 ? sanitizeToolVocabulary(prompt) : undefined;
}

function resolveMaxTokens(model: Model<Api>, options?: SimpleStreamOptions): number {
	const requested = options?.maxTokens ?? Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
	return Math.max(1, Math.min(requested, API_MAX_OUTPUT_TOKENS));
}

function buildRequest(
	model: Model<Api>,
	context: Context,
	config: ExtensionConfig,
	runtime: CommandCodeRuntimeState,
	options?: SimpleStreamOptions,
): CommandCodeRequest {
	return {
		memory: "",
		taste: null,
		skills: "",
		params: {
			tools: buildTools(context.tools),
			stream: true,
			max_tokens: resolveMaxTokens(model, options),
			temperature: options?.temperature,
			system: buildSystemPrompt(config, context),
			messages: buildMessages(context),
			model: model.id,
		},
		config: buildCommandConfig(runtime),
	};
}

function resolveApiKey(config: ExtensionConfig, options?: SimpleStreamOptions): string {
	const apiKey = options?.apiKey;
	if (!apiKey || (apiKey === config.apiKey && ENV_VAR_PATTERN.test(config.apiKey) && !process.env[config.apiKey])) {
		throw new Error(
			`No CommandCode API token configured. Set ${config.apiKey} or update pi-command-code-provider/config.json.`,
		);
	}
	return apiKey;
}

function buildHeaders(config: ExtensionConfig, apiKey: string, options?: SimpleStreamOptions): Record<string, string> {
	const headers: Record<string, string> = {
		...config.headers,
		...(options?.headers ?? {}),
		"Content-Type": "application/json",
		Accept: "text/event-stream, application/json",
		"X-Command-Code-Version": config.commandCodeVersion,
	};
	if (!headers.Authorization && !headers.authorization) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

function createRequestSignal(
	options: SimpleStreamOptions | undefined,
	timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	let disposed = false;
	const timeout = setTimeout(() => {
		if (!disposed) controller.abort(new Error(`CommandCode request timed out after ${timeoutMs}ms.`));
	}, timeoutMs);
	const abortFromParent = (): void => {
		if (!disposed) controller.abort(options?.signal?.reason ?? new Error("CommandCode request aborted."));
	};
	if (options?.signal?.aborted) abortFromParent();
	options?.signal?.addEventListener("abort", abortFromParent, { once: true });
	return {
		signal: controller.signal,
		dispose() {
			disposed = true;
			clearTimeout(timeout);
			options?.signal?.removeEventListener("abort", abortFromParent);
		},
	};
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
	const output: Record<string, string> = {};
	headers.forEach((value, key) => {
		output[key] = value;
	});
	return output;
}

async function readJsonResponse(response: Response): Promise<CommandCodeResponse> {
	const text = await response.text();
	if (!text.trim()) return {};
	try {
		const parsed = JSON.parse(text);
		return isRecord(parsed) ? parsed : { message: "CommandCode returned a non-object JSON response." };
	} catch {
		return { message: text };
	}
}

function extractErrorMessage(payload: CommandCodeResponse, status: number): string {
	if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
	if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
	if (isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.trim()) {
		return payload.error.message.trim();
	}
	return `CommandCode request failed with HTTP ${status}.`;
}

function numberFrom(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsage(model: Model<Api>, rawUsage: unknown): Usage {
	const usageRecord = isRecord(rawUsage) ? rawUsage : {};
	const rawInput = numberFrom(usageRecord.input_tokens);
	const output = numberFrom(usageRecord.output_tokens);
	const cacheRead = numberFrom(usageRecord.cache_read_input_tokens);
	const cacheWrite = numberFrom(usageRecord.cache_creation_input_tokens);
	const input = Math.max(0, rawInput - cacheRead - cacheWrite);
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function parseEventUsage(model: Model<Api>, rawUsage: unknown): Usage | undefined {
	if (!isRecord(rawUsage)) return undefined;
	const inputDetails = isRecord(rawUsage.inputTokenDetails) ? rawUsage.inputTokenDetails : {};
	const input =
		numberFrom(inputDetails.noCacheTokens ?? rawUsage.inputTokens) ||
		Math.max(0, numberFrom(rawUsage.inputTokens) - numberFrom(rawUsage.cachedInputTokens));
	const output = numberFrom(rawUsage.outputTokens);
	const cacheRead = numberFrom(inputDetails.cacheReadTokens ?? rawUsage.cachedInputTokens);
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function flattenTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (isRecord(part) && typeof part.text === "string") return part.text;
			return "";
		})
		.join("");
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function parseParameterValue(value: string): unknown {
	const decoded = decodeXmlEntities(value.trim());
	if (!decoded) return "";
	if (/^(?:true|false|null|-?\d+(?:\.\d+)?|[\[{])/.test(decoded)) {
		try {
			return JSON.parse(decoded);
		} catch {
			return decoded;
		}
	}
	return decoded;
}

function parseDsmlToolCalls(dsml: string, baseIndex: number): ToolCall[] {
	const toolCalls: ToolCall[] = [];
	const invokePattern = /<｜｜DSML｜｜invoke\s+[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/｜｜DSML｜｜invoke>/gi;
	let invokeMatch: RegExpExecArray | null;
	while ((invokeMatch = invokePattern.exec(dsml)) !== null) {
		const name = decodeXmlEntities(invokeMatch[1].trim());
		if (!name) continue;
		const args: Record<string, unknown> = {};
		const parameterPattern =
			/<｜｜DSML｜｜parameter\s+[^>]*name=["']([^"']+)["'][^>]*?(?:string=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/gi;
		let parameterMatch: RegExpExecArray | null;
		while ((parameterMatch = parameterPattern.exec(invokeMatch[2])) !== null) {
			const key = decodeXmlEntities(parameterMatch[1].trim());
			if (!key) continue;
			const rawValue = parameterMatch[3];
			args[key] = parameterMatch[2] === "true" ? decodeXmlEntities(rawValue.trim()) : parseParameterValue(rawValue);
		}
		toolCalls.push({
			type: "toolCall",
			id: `command-code-tool-${baseIndex + toolCalls.length}`,
			name,
			arguments: args,
		});
	}
	return toolCalls;
}

function parseXmlToolCalls(xml: string, baseIndex: number): ToolCall[] {
	const toolCalls: ToolCall[] = [];
	const toolCallPattern = /<tool_call\s+[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tool_call>/gi;
	let toolCallMatch: RegExpExecArray | null;
	while ((toolCallMatch = toolCallPattern.exec(xml)) !== null) {
		const name = decodeXmlEntities(toolCallMatch[1].trim());
		if (!name) continue;
		const body = toolCallMatch[2];
		const args: Record<string, unknown> = {};
		const parameterPattern = /<parameter\s+[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
		let parameterMatch: RegExpExecArray | null;
		while ((parameterMatch = parameterPattern.exec(body)) !== null) {
			const key = decodeXmlEntities(parameterMatch[1].trim());
			if (!key) continue;
			args[key] = parseParameterValue(parameterMatch[2]);
		}
		toolCalls.push({
			type: "toolCall",
			id: `command-code-tool-${baseIndex + toolCalls.length}`,
			name,
			arguments: args,
		});
	}
	return toolCalls;
}

function parseTextMarkup(text: string, baseIndex: number): ParsedContentBlock[] {
	const blocks: ParsedContentBlock[] = [];
	const pattern =
		/<thinking>([\s\S]*?)<\/thinking>|<tool_calls>([\s\S]*?)<\/tool_calls>|<｜｜DSML｜｜tool_calls>([\s\S]*?)<\/｜｜DSML｜｜tool_calls>/gi;
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const visible = text.slice(cursor, match.index);
		if (visible.trim().length > 0) blocks.push({ type: "text", text: visible.trim() });
		if (match[1] !== undefined) {
			const thinking = decodeXmlEntities(match[1].trim());
			if (thinking.length > 0) blocks.push({ type: "thinking", thinking });
		} else if (match[2] !== undefined) {
			blocks.push(
				...parseXmlToolCalls(match[2], baseIndex + blocks.length).map((toolCall) => ({
					type: "toolCall" as const,
					toolCall,
				})),
			);
		} else if (match[3] !== undefined) {
			blocks.push(
				...parseDsmlToolCalls(match[3], baseIndex + blocks.length).map((toolCall) => ({
					type: "toolCall" as const,
					toolCall,
				})),
			);
		}
		cursor = pattern.lastIndex;
	}
	const rest = text.slice(cursor);
	if (rest.trim().length > 0) blocks.push({ type: "text", text: rest.trim() });
	return blocks;
}

function parseToolCall(part: Record<string, unknown>, index: number): ToolCall | null {
	const type = typeof part.type === "string" ? part.type : "";
	if (type !== "tool_use" && type !== "toolUse" && type !== "toolCall" && type !== "tool-call") return null;
	const name = optionalString(part.name) ?? optionalString(part.toolName) ?? "tool";
	const id = optionalString(part.id) ?? optionalString(part.toolCallId) ?? `command-code-tool-${index}`;
	const rawArguments = part.input ?? part.arguments ?? {};
	return {
		type: "toolCall",
		id,
		name,
		arguments: isRecord(rawArguments) ? rawArguments : { value: rawArguments },
	};
}

function parseContentBlocks(content: unknown): ParsedContentBlock[] {
	if (typeof content === "string") return content ? parseTextMarkup(content, 0) : [];
	if (!Array.isArray(content)) return [];
	const blocks: ParsedContentBlock[] = [];
	content.forEach((part, index) => {
		if (typeof part === "string") {
			if (part) blocks.push(...parseTextMarkup(part, index));
			return;
		}
		if (!isRecord(part)) return;
		const toolCall = parseToolCall(part, index);
		if (toolCall) {
			blocks.push({ type: "toolCall", toolCall });
			return;
		}
		if (part.type === "thinking" || part.type === "reasoning") {
			const thinking =
				typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
			if (thinking.length > 0) blocks.push({ type: "thinking", thinking });
			return;
		}
		if (typeof part.text === "string" && part.text.length > 0) {
			blocks.push(...parseTextMarkup(part.text, index));
		}
	});
	return blocks;
}

function mapStopReason(
	rawStopReason: unknown,
	hasToolCalls: boolean,
): { stopReason: "stop" | "length" | "toolUse" | "error"; errorMessage?: string } {
	const reason = typeof rawStopReason === "string" ? rawStopReason : "stop";
	switch (reason) {
		case "end_turn":
		case "stop":
		case "stop_sequence":
			return { stopReason: hasToolCalls ? "toolUse" : "stop" };
		case "max_tokens":
		case "length":
			return { stopReason: "length" };
		case "tool_use":
		case "tool-calls":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "CommandCode stop_reason: content_filter" };
		default:
			return { stopReason: hasToolCalls ? "toolUse" : "stop" };
	}
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function emitTextStart(stream: AssistantMessageEventStream, output: AssistantMessage): number {
	const contentIndex = output.content.length;
	output.content.push({ type: "text", text: "" });
	stream.push({ type: "text_start", contentIndex, partial: output });
	return contentIndex;
}

function emitTextDelta(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	delta: string,
): void {
	const block = output.content[contentIndex];
	if (block?.type === "text") block.text += delta;
	stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

function emitTextEnd(stream: AssistantMessageEventStream, output: AssistantMessage, contentIndex: number): void {
	const block = output.content[contentIndex];
	const content = block?.type === "text" ? block.text : "";
	stream.push({ type: "text_end", contentIndex, content, partial: output });
}

function emitText(stream: AssistantMessageEventStream, output: AssistantMessage, text: string): void {
	const contentIndex = emitTextStart(stream, output);
	if (text.length > 0) emitTextDelta(stream, output, contentIndex, text);
	emitTextEnd(stream, output, contentIndex);
}

function emitThinkingStart(stream: AssistantMessageEventStream, output: AssistantMessage): number {
	const contentIndex = output.content.length;
	output.content.push({ type: "thinking", thinking: "" });
	stream.push({ type: "thinking_start", contentIndex, partial: output });
	return contentIndex;
}

function emitThinkingDelta(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	delta: string,
): void {
	const block = output.content[contentIndex];
	if (block?.type === "thinking") block.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

function emitThinkingEnd(stream: AssistantMessageEventStream, output: AssistantMessage, contentIndex: number): void {
	const block = output.content[contentIndex];
	const content = block?.type === "thinking" ? block.thinking : "";
	stream.push({ type: "thinking_end", contentIndex, content, partial: output });
}

function emitThinking(stream: AssistantMessageEventStream, output: AssistantMessage, thinking: string): void {
	const contentIndex = emitThinkingStart(stream, output);
	if (thinking.length > 0) emitThinkingDelta(stream, output, contentIndex, thinking);
	emitThinkingEnd(stream, output, contentIndex);
}

function hasTool(context: Context, name: string): boolean {
	return context.tools?.some((tool) => tool.name === name) ?? false;
}

const COMMAND_CODE_TOOL_ALIASES: Record<string, string> = {
	read_file: "read",
	write_file: "write",
	edit_file: "edit",
	read_directory: "ls",
	shell_command: "bash",
	glob: "find",
};

function normalizeToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
	if (name === "grep" && Object.hasOwn(args, "filePattern") && !Object.hasOwn(args, "glob")) {
		const { filePattern, ...rest } = args;
		return { ...rest, glob: filePattern };
	}
	if (name === "read" && Object.hasOwn(args, "absolutePath") && !Object.hasOwn(args, "path")) {
		const { absolutePath, ...rest } = args;
		return { ...rest, path: absolutePath };
	}
	if (name === "write" && Object.hasOwn(args, "filePath") && !Object.hasOwn(args, "path")) {
		const { filePath, ...rest } = args;
		return { ...rest, path: filePath };
	}
	if (
		name === "edit" &&
		(Object.hasOwn(args, "filePath") || Object.hasOwn(args, "oldValue") || Object.hasOwn(args, "newValue"))
	) {
		const {
			filePath,
			oldValue,
			newValue,
			replaceAll: _replaceAll,
			replacementCount: _replacementCount,
			...rest
		} = args;
		if (Object.hasOwn(args, "edits")) return { ...rest, filePath, oldValue, newValue };
		if (typeof oldValue === "string" && typeof newValue === "string") {
			return {
				...rest,
				path: typeof filePath === "string" ? filePath : rest.path,
				edits: [{ oldText: oldValue, newText: newValue }],
			};
		}
		return { ...rest, path: typeof filePath === "string" ? filePath : rest.path };
	}
	if (name === "bash" && Object.hasOwn(args, "command") && !Object.hasOwn(args, "timeout")) {
		return args;
	}
	return args;
}

function normalizeToolCallForContext(toolCall: ToolCall, context: Context): ToolCall {
	const alias = COMMAND_CODE_TOOL_ALIASES[toolCall.name];
	const name = alias && hasTool(context, alias) && !hasTool(context, toolCall.name) ? alias : toolCall.name;
	return { ...toolCall, name, arguments: normalizeToolArguments(name, toolCall.arguments) };
}

function emitToolCall(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	toolCall: ToolCall,
	context: Context,
): void {
	const normalizedToolCall = normalizeToolCallForContext(toolCall, context);
	const contentIndex = output.content.length;
	output.content.push(normalizedToolCall);
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({
		type: "toolcall_delta",
		contentIndex,
		delta: JSON.stringify(normalizedToolCall.arguments),
		partial: output,
	});
	stream.push({
		type: "toolcall_end",
		contentIndex,
		toolCall: normalizedToolCall,
		partial: output,
	});
}

function emitResponse(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	response: CommandCodeResponse,
	model: Model<Api>,
	context: Context,
): void {
	output.responseId = typeof response.id === "string" ? response.id : undefined;
	output.responseModel =
		typeof response.model === "string" && response.model !== model.id ? response.model : undefined;
	output.usage = parseUsage(model, response.usage);
	stream.push({ type: "start", partial: output });

	let blocks = parseContentBlocks(response.content);
	if (blocks.length === 0) {
		const text = flattenTextContent(response.content);
		if (text) blocks = [{ type: "text", text }];
	}

	let hasToolCalls = false;
	for (const block of blocks) {
		if (block.type === "text") emitText(stream, output, block.text);
		if (block.type === "thinking") emitThinking(stream, output, block.thinking);
		if (block.type === "toolCall") {
			hasToolCalls = true;
			emitToolCall(stream, output, block.toolCall, context);
		}
	}

	const stop = mapStopReason(response.stop_reason, hasToolCalls);
	output.stopReason = stop.stopReason;
	output.errorMessage = stop.errorMessage;
	if (output.stopReason === "error") {
		stream.push({ type: "error", reason: "error", error: output });
		stream.end(output);
		return;
	}
	stream.push({ type: "done", reason: output.stopReason, message: output });
	stream.end(output);
}

function parseSseLine(line: string): unknown | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	const jsonText = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
	if (!jsonText || jsonText === "[DONE]") return undefined;
	try {
		return JSON.parse(jsonText);
	} catch {
		return undefined;
	}
}

function eventText(event: Record<string, unknown>): string {
	return typeof event.text === "string" ? event.text : typeof event.delta === "string" ? event.delta : "";
}

function eventId(event: Record<string, unknown>): string {
	return typeof event.id === "string" ? event.id : "default";
}

async function consumeEventStream(
	response: Response,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model<Api>,
	context: Context,
): Promise<void> {
	stream.push({ type: "start", partial: output });
	const textBlocks = new Map<string, number>();
	const thinkingBlocks = new Map<string, number>();
	const toolInputs = new Map<string, ToolInputAccumulator>();
	let hasToolCalls = false;
	let finalReason: "stop" | "length" | "toolUse" | "error" = "stop";
	let finalError: string | undefined;

	const handleEvent = (event: unknown): void => {
		if (!isRecord(event)) return;
		const type = optionalString(event.type);
		if (!type || type === "start" || type === "start-step" || type === "provider-metadata") return;

		if (type === "text-start") {
			textBlocks.set(eventId(event), emitTextStart(stream, output));
			return;
		}
		if (type === "text-delta") {
			const id = eventId(event);
			const contentIndex = textBlocks.get(id) ?? emitTextStart(stream, output);
			textBlocks.set(id, contentIndex);
			emitTextDelta(stream, output, contentIndex, eventText(event));
			return;
		}
		if (type === "text-end") {
			const id = eventId(event);
			const contentIndex = textBlocks.get(id);
			if (contentIndex !== undefined) emitTextEnd(stream, output, contentIndex);
			textBlocks.delete(id);
			return;
		}

		if (type === "reasoning-start" || type === "thinking-start") {
			thinkingBlocks.set(eventId(event), emitThinkingStart(stream, output));
			return;
		}
		if (type === "reasoning-delta" || type === "thinking-delta") {
			const id = eventId(event);
			const contentIndex = thinkingBlocks.get(id) ?? emitThinkingStart(stream, output);
			thinkingBlocks.set(id, contentIndex);
			emitThinkingDelta(stream, output, contentIndex, eventText(event));
			return;
		}
		if (type === "reasoning-end" || type === "thinking-end") {
			const id = eventId(event);
			const contentIndex = thinkingBlocks.get(id);
			if (contentIndex !== undefined) emitThinkingEnd(stream, output, contentIndex);
			thinkingBlocks.delete(id);
			return;
		}

		if (type === "tool-input-start") {
			const id = eventId(event);
			toolInputs.set(id, { id, toolName: optionalString(event.toolName) ?? "tool", inputText: "" });
			return;
		}
		if (type === "tool-input-delta") {
			const id = eventId(event);
			const accumulator = toolInputs.get(id) ?? {
				id,
				toolName: optionalString(event.toolName) ?? "tool",
				inputText: "",
			};
			accumulator.inputText += eventText(event);
			toolInputs.set(id, accumulator);
			return;
		}
		if (type === "tool-call") {
			const id =
				optionalString(event.toolCallId) ??
				optionalString(event.id) ??
				`command-code-tool-${output.content.length}`;
			const accumulator = toolInputs.get(id);
			const rawInput = event.input ?? accumulator?.inputText ?? {};
			let args: Record<string, unknown>;
			if (isRecord(rawInput)) {
				args = rawInput;
			} else if (typeof rawInput === "string" && rawInput.trim().length > 0) {
				try {
					const parsed = JSON.parse(rawInput);
					args = isRecord(parsed) ? parsed : { value: parsed };
				} catch {
					args = { value: rawInput };
				}
			} else {
				args = {};
			}
			hasToolCalls = true;
			emitToolCall(
				stream,
				output,
				{
					type: "toolCall",
					id,
					name: optionalString(event.toolName) ?? accumulator?.toolName ?? "tool",
					arguments: args,
				},
				context,
			);
			return;
		}

		if (type === "finish-step" || type === "finish") {
			const usage = parseEventUsage(model, event.totalUsage ?? event.usage);
			if (usage) output.usage = usage;
			const mapped = mapStopReason(event.finishReason ?? event.rawFinishReason, hasToolCalls);
			finalReason = mapped.stopReason;
			finalError = mapped.errorMessage;
			return;
		}

		if (type === "error") {
			finalReason = "error";
			finalError =
				optionalString(event.message) ?? optionalString(event.error) ?? "CommandCode stream returned an error.";
		}
	};

	const decoder = new TextDecoder();
	let buffered = "";
	if (!response.body) throw new Error("CommandCode response did not include a readable body.");
	for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
		buffered += decoder.decode(chunk, { stream: true });
		const lines = buffered.split(/\r?\n/);
		buffered = lines.pop() ?? "";
		for (const line of lines) handleEvent(parseSseLine(line));
	}
	buffered += decoder.decode();
	if (buffered.trim()) {
		for (const line of buffered.split(/\r?\n/)) handleEvent(parseSseLine(line));
	}

	for (const contentIndex of textBlocks.values()) emitTextEnd(stream, output, contentIndex);
	for (const contentIndex of thinkingBlocks.values()) emitThinkingEnd(stream, output, contentIndex);

	const finalStopReason = finalReason as "stop" | "length" | "toolUse" | "error";
	output.stopReason = finalStopReason;
	output.errorMessage = finalError;
	if (finalStopReason === "error") {
		stream.push({ type: "error", reason: "error", error: output });
		stream.end(output);
		return;
	}
	stream.push({ type: "done", reason: finalStopReason, message: output });
	stream.end(output);
}

async function executeCommandCodeRequest(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model<Api>,
	context: Context,
	config: ExtensionConfig,
	runtime: CommandCodeRuntimeState,
	logger: DebugLogger,
	options?: SimpleStreamOptions,
): Promise<void> {
	const apiKey = resolveApiKey(config, options);
	const signal = createRequestSignal(options, options?.timeoutMs ?? config.requestTimeoutMs);
	try {
		const request = buildRequest(model, context, config, runtime, options);
		const payload = options?.onPayload ? ((await options.onPayload(request, model)) ?? request) : request;
		const response = await fetch(`${config.upstreamUrl.replace(/\/+$/, "")}/alpha/generate`, {
			method: "POST",
			headers: buildHeaders(config, apiKey, options),
			body: JSON.stringify(payload),
			signal: signal.signal,
		});

		await options?.onResponse?.(
			{ status: response.status, headers: responseHeadersToRecord(response.headers) },
			model,
		);

		if (!response.ok) {
			const errorPayload = await readJsonResponse(response);
			throw new Error(extractErrorMessage(errorPayload, response.status));
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			await consumeEventStream(response, stream, output, model, context);
			return;
		}

		const payloadResponse = await readJsonResponse(response);
		emitResponse(stream, output, payloadResponse, model, context);
	} catch (error) {
		const aborted = signal.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : "Unknown CommandCode request error.";
		logger.error("request_failed", {
			model: model.id,
			stopReason: output.stopReason,
			error: output.errorMessage,
		});
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end(output);
	} finally {
		signal.dispose();
	}
}

export function createCommandCodeStream(
	config: ExtensionConfig,
	runtime: CommandCodeRuntimeState,
	logger: DebugLogger,
) {
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const output = createOutput(model);
		void executeCommandCodeRequest(stream, output, model, context, config, runtime, logger, options);
		return stream;
	};
}
