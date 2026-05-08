import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type SelectItem } from "@earendil-works/pi-tui";
import { matchesConfiguredShortcut } from "./shortcuts.ts";
import type { PowerlineShortcuts } from "./helpers.js";
import type { BashModeSettings } from "./bash-mode/types.ts";
import {
	hasNonWhitespaceText,
	getCurrentEditorText,
	buildStashPreview,
	pushStashHistory,
	persistStashHistory,
	readRecentProjectPrompts,
	STASH_PREVIEW_WIDTH,
	PROJECT_PROMPT_HISTORY_LIMIT,
} from "./helpers.js";
import { getChatJumpShortcutAction, jumpToChatMessage, jumpChatToBottom } from "./chat-jump.js";
import { showSelectOverlay } from "./overlay-helpers.js";
import type { PowerlineShortcutAction } from "./helpers.js";

/** Mutable state shared between the stash commands and the factory. */
export interface StashState {
	stashedPromptHistory: string[];
	stashedEditorText: string | null;
}

export function addStashHistoryEntry(state: StashState, text: string): void {
	const changed = pushStashHistory(state.stashedPromptHistory, text);
	if (!changed) return;
	persistStashHistory(state.stashedPromptHistory);
}

export function copyTextToClipboard(ctx: any, text: string, successMessage?: string): void {
	copyToClipboard(text);
	if (successMessage) {
		ctx.ui.notify(successMessage, "info");
	}
}

export function getEditorTextForClipboard(ctx: any, currentEditor: any): string | null {
	const text = getCurrentEditorText(ctx, currentEditor);
	if (hasNonWhitespaceText(text)) return text;
	ctx.ui.notify("Editor is empty", "info");
	return null;
}

export async function selectStashedPromptFromHistory(ctx: any, state: StashState): Promise<string | null> {
	const historyItems = [...state.stashedPromptHistory];
	const items: SelectItem[] = historyItems.map((entry, index) => ({
		value: String(index),
		label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
	}));

	const selected = await showSelectOverlay(
		ctx,
		"Stash history",
		"↑↓ navigate • enter insert • esc cancel",
		items,
		Math.min(items.length, 10),
	);
	if (!selected) return null;

	const i = Number.parseInt(selected.value, 10);
	return historyItems[i] ?? null;
}

export async function selectProjectPromptFromHistory(ctx: any, prompts: string[]): Promise<string | null> {
	const items: SelectItem[] = prompts.map((entry, index) => ({
		value: String(index),
		label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
	}));

	const selected = await showSelectOverlay(
		ctx,
		"Recent project prompts",
		"↑↓ navigate • enter insert • esc cancel",
		items,
		Math.min(items.length, 10),
	);
	if (!selected) return null;

	const i = Number.parseInt(selected.value, 10);
	return prompts[i] ?? null;
}

export async function selectPromptHistorySource(
	ctx: any,
	stashCount: number,
	projectPromptCount: number,
): Promise<"stash" | "project" | null> {
	const items: SelectItem[] = [];

	if (stashCount > 0) {
		items.push({
			value: "stash",
			label: "Stashed prompts",
			description: `${stashCount} saved`,
		});
	}

	if (projectPromptCount > 0) {
		items.push({
			value: "project",
			label: "Recent project prompts",
			description: `${projectPromptCount} recent`,
		});
	}

	if (items.length === 0) return null;
	if (items.length === 1) return items[0]?.value === "project" ? "project" : "stash";

	const selected = await showSelectOverlay(
		ctx,
		"Prompt history",
		"↑↓ navigate • enter open • esc cancel",
		items,
		items.length,
	);
	if (!selected) return null;

	return selected.value === "project" ? "project" : "stash";
}

export async function insertSelectedPromptHistoryEntry(ctx: any, selected: string, currentEditor: any): Promise<void> {
	const currentText = getCurrentEditorText(ctx, currentEditor);
	if (!hasNonWhitespaceText(currentText)) {
		ctx.ui.setEditorText(selected);
		ctx.ui.notify("Inserted prompt", "info");
		return;
	}

	const action = await ctx.ui.select("Insert prompt", ["Replace", "Append", "Cancel"]);

	if (action === "Replace") {
		ctx.ui.setEditorText(selected);
		ctx.ui.notify("Replaced editor with prompt", "info");
		return;
	}

	if (action === "Append") {
		const separator = currentText.endsWith("\n") || selected.startsWith("\n") ? "" : "\n";
		ctx.ui.setEditorText(`${currentText}${separator}${selected}`);
		ctx.ui.notify("Appended prompt", "info");
	}
}

export function isStashShortcutInput(data: string): boolean {
	if (isKeyRelease(data)) return false;

	return (
		data === "ß" ||
		data === "\x1bs" ||
		data === "\x1bS" ||
		/^\x1b\[(?:83|115)(?::\d*)?(?::\d*)?;3(?::\d+)?u$/.test(data) ||
		data === "\x1b[27;3;115~" ||
		data === "\x1b[27;3;83~" ||
		matchesKey(data, "alt+s")
	);
}

export function isPromptHistoryShortcutInput(data: string, resolvedShortcuts: PowerlineShortcuts): boolean {
	return (
		matchesConfiguredShortcut(data, resolvedShortcuts.stashHistory) ||
		(resolvedShortcuts.stashHistory === "ctrl+alt+h" &&
			(/^\x1b\[104(?::\d*)?(?::\d*)?;7(?::\d+)?u$/.test(data) ||
				data === "\x1b[27;7;104~" ||
				data === "\x1b[27;7;72~"))
	);
}

export function getPowerlineShortcutAction(
	data: string,
	resolvedShortcuts: PowerlineShortcuts,
	bashModeSettings: BashModeSettings,
): PowerlineShortcutAction | null {
	if (isKeyRelease(data)) return null;

	if (isPromptHistoryShortcutInput(data, resolvedShortcuts)) {
		return { kind: "stashHistory" };
	}
	if (matchesConfiguredShortcut(data, resolvedShortcuts.copyEditor)) {
		return { kind: "copyEditor" };
	}
	if (matchesConfiguredShortcut(data, resolvedShortcuts.cutEditor)) {
		return { kind: "cutEditor" };
	}
	if (matchesConfiguredShortcut(data, bashModeSettings.toggleShortcut)) {
		return { kind: "bashMode" };
	}

	const chatJumpAction = getChatJumpShortcutAction(data, resolvedShortcuts);
	return chatJumpAction ? { kind: "chat", action: chatJumpAction } : null;
}

export function runPowerlineShortcut(
	ctx: any,
	action: PowerlineShortcutAction,
	state: StashState,
	currentEditor: any,
	bashModeActive: boolean,
	fixedEditorCompositor: any,
	tuiRef: any,
	setBashModeActive: (value: boolean, ctx: any) => Promise<void>,
): void {
	if (action.kind === "stashHistory") {
		void openStashHistory(ctx, state);
		return;
	}

	if (action.kind === "copyEditor" || action.kind === "cutEditor") {
		const text = getEditorTextForClipboard(ctx, currentEditor);
		if (!text) return;

		copyTextToClipboard(ctx, text, action.kind === "copyEditor" ? "Copied editor text" : undefined);
		if (action.kind === "cutEditor") {
			ctx.ui.setEditorText("");
			ctx.ui.notify("Cut editor text", "info");
		}
		return;
	}

	if (action.kind === "bashMode") {
		void setBashModeActive(!bashModeActive, ctx);
		return;
	}

	if (action.action.kind === "bottom") {
		jumpChatToBottom(ctx, fixedEditorCompositor);
		return;
	}

	jumpToChatMessage(ctx, action.action.role, action.action.direction, fixedEditorCompositor, tuiRef);
}

export function stashOrRestoreEditorText(ctx: any, state: StashState, currentEditor: any): void {
	const rawText = getCurrentEditorText(ctx, currentEditor);
	const hasStash = state.stashedEditorText !== null;

	if (!hasNonWhitespaceText(rawText)) {
		if (!hasStash) {
			ctx.ui.notify("Nothing to stash", "info");
			return;
		}

		ctx.ui.setEditorText(state.stashedEditorText);
		state.stashedEditorText = null;
		ctx.ui.setStatus("stash", undefined);
		ctx.ui.notify("Stash restored", "info");
		return;
	}

	state.stashedEditorText = rawText;
	addStashHistoryEntry(state, rawText);
	ctx.ui.setEditorText("");
	ctx.ui.setStatus("stash", "stash");
	ctx.ui.notify(hasStash ? "Stash updated" : "Text stashed", "info");
}

export async function openStashHistory(ctx: any, state: StashState): Promise<void> {
	let projectPrompts: string[] = [];

	try {
		projectPrompts = readRecentProjectPrompts(ctx.cwd, PROJECT_PROMPT_HISTORY_LIMIT);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to load project prompts: ${message}`, "warning");
	}

	if (state.stashedPromptHistory.length === 0 && projectPrompts.length === 0) {
		ctx.ui.notify("No prompt history yet", "info");
		return;
	}

	const source = await selectPromptHistorySource(ctx, state.stashedPromptHistory.length, projectPrompts.length);
	if (!source) return;

	const selected =
		source === "project"
			? await selectProjectPromptFromHistory(ctx, projectPrompts)
			: await selectStashedPromptFromHistory(ctx, state);
	if (!selected) return;

	await insertSelectedPromptHistoryEntry(ctx, selected, null);
}
