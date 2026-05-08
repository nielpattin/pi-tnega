import { type ExtensionAPI, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, type KeyId } from "@earendil-works/pi-tui";

import type { PowerlineConfig } from "./powerline-config.js";
import { BashTranscriptStore } from "./bash-mode/transcript.ts";
import {
	BashCompletionEngine,
	BashAutocompleteProvider,
	getOneOffBashCommandContext,
	ModeAwareAutocompleteProvider,
	OneOffBashAutocompleteProvider,
} from "./bash-mode/completion.ts";
import { BashModeEditor } from "./bash-mode/editor.ts";
import { ManagedShellSession } from "./bash-mode/shell-session.ts";
import {
	matchHistoryEntries,
	readGlobalShellHistory,
	readProjectHistory,
	appendProjectHistory,
} from "./bash-mode/history.ts";
import { PRESETS } from "./presets.js";
import { parsePowerlineConfig } from "./powerline-config.js";
import { invalidateGitStatus, invalidateGitBranch } from "./git-status.js";
import { ansi, getFgAnsiCode } from "./colors.js";
import { createRenderScheduler } from "./render-scheduler.ts";
import { TerminalSplitCompositor } from "./fixed-editor/terminal-split.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

let config: PowerlineConfig = {
	preset: "default",
	customItems: [],
	mouseScroll: true,
	fixedEditor: true,
};

let customCompactionEnabled = false;
import {
	type SessionAssistantUsage,
	CHAT_JUMP_SHORTCUTS,
	STATUS_RENDER_DEBOUNCE_MS,
	CONTEXT_STATUS_RENDER_MS,
	EDITOR_STATUS_DEFER_MS,
	PRESET_NAMES,
	getUsageTokenTotal,
	isSessionAssistantMessage,
	getPromptHistoryState,
	snapshotPromptHistory,
	restorePromptHistory,
	trackPromptHistory,
	detectCustomCompactionEnabled,
	readPersistedStashHistory,
	readSettings,
	writePowerlinePresetSetting,
	writePowerlineOptionSetting,
	hasNonWhitespaceText,
	getCurrentEditorText,
	resolveShortcutConfig,
	parseBashModeSettings,
	normalizePreset,
} from "./helpers.js";
import {
	type StashState,
	copyTextToClipboard,
	getEditorTextForClipboard,
	isStashShortcutInput,
	getPowerlineShortcutAction,
	runPowerlineShortcut,
	stashOrRestoreEditorText,
	openStashHistory,
} from "./stash-commands.js";

import { followSubmittedEditorToBottom } from "./chat-jump.js";
import { type RenderDeps, type LayoutCache, createRenderFunctions } from "./powerline-render.js";
import {
	type FixedEditorState,
	type FixedEditorContext,
	teardownFixedEditorCompositor,
	installFixedEditorCompositor,
	installPowerlineWidgets,
} from "./fixed-editor-setup.js";

export default function powerlineFooter(pi: ExtensionAPI) {
	const startupSettings = readSettings();
	config = parsePowerlineConfig(startupSettings.powerline, PRESET_NAMES);
	let resolvedShortcuts = resolveShortcutConfig(startupSettings);
	let bashModeSettings = parseBashModeSettings(startupSettings);

	let enabled = true;
	let sessionStartTime = Date.now();
	let currentCtx: any = null;
	let footerDataRef: ReadonlyFooterDataProvider | null = null;
	let getThinkingLevelFn: (() => string) | null = null;
	let currentThinkingLevel: string | null = null;
	let liveAssistantUsage: SessionAssistantUsage | null = null;
	let isStreaming = false;
	let tuiRef: any = null;
	let restoreFooterStatusRepaintHook: (() => void) | null = null;
	let fixedEditorCompositor: TerminalSplitCompositor | null = null;
	let fixedStatusContainer: any = null;
	let fixedEditorContainer: any = null;
	let fixedWidgetContainerAbove: any = null;
	let fixedWidgetContainerBelow: any = null;
	let stashShortcutInputUnsubscribe: (() => void) | null = null;
	let lastUserPrompt = "";
	let showLastPrompt = true;
	let stashedEditorText: string | null = null;
	let stashedPromptHistory: string[] = readPersistedStashHistory();
	const stashState: StashState = {
		get stashedEditorText() {
			return stashedEditorText;
		},
		set stashedEditorText(value: string | null) {
			stashedEditorText = value;
		},
		get stashedPromptHistory() {
			return stashedPromptHistory;
		},
		set stashedPromptHistory(value: string[]) {
			stashedPromptHistory = value;
		},
	};
	let currentEditor: any = null;
	let bashModeActive = false;
	let bashTranscript = new BashTranscriptStore(bashModeSettings);
	let bashCompletionEngine = new BashCompletionEngine();
	let shellSession: ManagedShellSession | null = null;

	// Cache for the top and secondary powerline widgets.
	let lastLayoutWidth = 0;
	let lastLayoutResult: { topContent: string; secondaryContent: string } | null = null;
	let lastLayoutTimestamp = 0;
	let layoutDirty = true;
	let forceNextLayoutRecompute = false;
	let lastEditorInputAt = 0;

	const renderDeps: RenderDeps = {
		get config() {
			return config;
		},
		get currentCtx() {
			return currentCtx;
		},
		get footerDataRef() {
			return footerDataRef;
		},
		get isStreaming() {
			return isStreaming;
		},
		get liveAssistantUsage() {
			return liveAssistantUsage;
		},
		get bashModeActive() {
			return bashModeActive;
		},
		get bashTranscript() {
			return bashTranscript;
		},
		get shellSession() {
			return shellSession;
		},
		get showLastPrompt() {
			return showLastPrompt;
		},
		get lastUserPrompt() {
			return lastUserPrompt;
		},
		get customCompactionEnabled() {
			return customCompactionEnabled;
		},
		get sessionStartTime() {
			return sessionStartTime;
		},
		get currentThinkingLevel() {
			return currentThinkingLevel;
		},
		get getThinkingLevelFn() {
			return getThinkingLevelFn;
		},
		get lastEditorInputAt() {
			return lastEditorInputAt;
		},
	};
	const layoutCache: LayoutCache = {
		get lastLayoutWidth() {
			return lastLayoutWidth;
		},
		set lastLayoutWidth(v: number) {
			lastLayoutWidth = v;
		},
		get lastLayoutResult() {
			return lastLayoutResult;
		},
		set lastLayoutResult(v) {
			lastLayoutResult = v;
		},
		get lastLayoutTimestamp() {
			return lastLayoutTimestamp;
		},
		set lastLayoutTimestamp(v: number) {
			lastLayoutTimestamp = v;
		},
		get layoutDirty() {
			return layoutDirty;
		},
		set layoutDirty(v: boolean) {
			layoutDirty = v;
		},
		get forceNextLayoutRecompute() {
			return forceNextLayoutRecompute;
		},
		set forceNextLayoutRecompute(v: boolean) {
			forceNextLayoutRecompute = v;
		},
	};
	const renderFns = createRenderFunctions(renderDeps, layoutCache);

	const getShellPath = () => process.env.SHELL || "/bin/sh";
	const getShellCwd = () => shellSession?.state.cwd ?? currentCtx?.cwd ?? process.cwd();
	const asKeyId = (shortcut: string): KeyId => shortcut as KeyId;

	const statusRenderScheduler = createRenderScheduler(() => {
		const msSinceInput = Date.now() - lastEditorInputAt;
		if (layoutDirty && !forceNextLayoutRecompute && msSinceInput < EDITOR_STATUS_DEFER_MS) {
			statusRenderScheduler.schedule(Math.max(0, EDITOR_STATUS_DEFER_MS - msSinceInput));
			return;
		}

		tuiRef?.requestRender();
	}, STATUS_RENDER_DEBOUNCE_MS);

	const resetLayoutCache = () => {
		lastLayoutResult = null;
		layoutDirty = true;
	};

	const requestStatusRender = (delayMs?: number) => {
		layoutDirty = true;
		statusRenderScheduler.schedule(delayMs);
	};

	const requestImmediateStatusRender = (options: { deferDuringTyping?: boolean } = {}) => {
		layoutDirty = true;
		if (options.deferDuringTyping !== false && Date.now() - lastEditorInputAt < EDITOR_STATUS_DEFER_MS) {
			statusRenderScheduler.schedule();
			return;
		}

		forceNextLayoutRecompute = true;
		statusRenderScheduler.cancel();
		statusRenderScheduler.schedule(0);
	};

	const installFooterStatusRepaintHook = (footerData: ReadonlyFooterDataProvider) => {
		restoreFooterStatusRepaintHook?.();
		restoreFooterStatusRepaintHook = null;

		const writableFooterData = footerData as ReadonlyFooterDataProvider & {
			setExtensionStatus?: (key: string, text: string | undefined) => void;
			clearExtensionStatuses?: () => void;
		};
		if (typeof writableFooterData.setExtensionStatus !== "function") return;

		const originalSetExtensionStatus = writableFooterData.setExtensionStatus;
		const originalClearExtensionStatuses = writableFooterData.clearExtensionStatuses;
		const setExtensionStatusAndRepaint = function setExtensionStatusAndRepaint(
			this: unknown,
			key: string,
			text: string | undefined,
		) {
			originalSetExtensionStatus.call(this, key, text);
			requestImmediateStatusRender();
		};
		writableFooterData.setExtensionStatus = setExtensionStatusAndRepaint;

		let clearExtensionStatusesAndRepaint: (() => void) | null = null;
		if (typeof originalClearExtensionStatuses === "function") {
			clearExtensionStatusesAndRepaint = function clearExtensionStatusesAndRepaint(this: unknown) {
				originalClearExtensionStatuses.call(this);
				requestImmediateStatusRender();
			};
			writableFooterData.clearExtensionStatuses = clearExtensionStatusesAndRepaint;
		}

		restoreFooterStatusRepaintHook = () => {
			if (writableFooterData.setExtensionStatus === setExtensionStatusAndRepaint) {
				writableFooterData.setExtensionStatus = originalSetExtensionStatus;
			}
			if (
				clearExtensionStatusesAndRepaint &&
				writableFooterData.clearExtensionStatuses === clearExtensionStatusesAndRepaint
			) {
				writableFooterData.clearExtensionStatuses = originalClearExtensionStatuses;
			}
		};
	};

	const fixedEditorState: FixedEditorState = {
		get compositor() {
			return fixedEditorCompositor;
		},
		set compositor(v: any) {
			fixedEditorCompositor = v;
		},
		get statusContainer() {
			return fixedStatusContainer;
		},
		set statusContainer(v: any) {
			fixedStatusContainer = v;
		},
		get editorContainer() {
			return fixedEditorContainer;
		},
		set editorContainer(v: any) {
			fixedEditorContainer = v;
		},
		get widgetContainerAbove() {
			return fixedWidgetContainerAbove;
		},
		set widgetContainerAbove(v: any) {
			fixedWidgetContainerAbove = v;
		},
		get widgetContainerBelow() {
			return fixedWidgetContainerBelow;
		},
		set widgetContainerBelow(v: any) {
			fixedWidgetContainerBelow = v;
		},
	};
	const fixedEditorContext: FixedEditorContext = {
		renderFns,
		state: fixedEditorState,
		getConfig: () => config,
		getCurrentEditor: () => currentEditor,
		getResolvedShortcuts: () => resolvedShortcuts,
		getCurrentCtx: () => currentCtx,
		getFooterDataRef: () => footerDataRef,
		requestStatusRender,
		resetLayoutCache,
	};

	const getShellHistoryEntries = (prefix: string): string[] => {
		const project = matchHistoryEntries(
			readProjectHistory(currentCtx?.cwd ?? process.cwd()).map((entry) => entry.command),
			prefix,
			50,
		);
		const global = matchHistoryEntries(readGlobalShellHistory(getShellPath()), prefix, 50);
		return [...new Set([...project, ...global])];
	};

	const ensureShellSession = async (): Promise<ManagedShellSession> => {
		if (!shellSession) {
			shellSession = new ManagedShellSession(
				getShellPath(),
				currentCtx?.cwd ?? process.cwd(),
				bashTranscript,
				requestStatusRender,
				(command, cwd) => appendProjectHistory(currentCtx?.cwd ?? process.cwd(), command, cwd),
			);
		}
		await shellSession.ensureReady();
		return shellSession;
	};

	const runShellCommand = async (command: string, ctx: any): Promise<void> => {
		try {
			const session = await ensureShellSession();
			await session.runCommand(command);
			requestStatusRender();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to run shell command: ${message}`, "error");
		}
	};

	const setBashModeActive = async (value: boolean, ctx: any): Promise<void> => {
		if (value === bashModeActive) return;
		if (!value && shellSession?.state.running) {
			ctx.ui.notify("Wait for the current shell command to finish before leaving bash mode", "warning");
			return;
		}

		if (value) {
			try {
				const session = await ensureShellSession();
				bashModeActive = true;
				currentEditor?.dismissBashModeUi?.();
				currentEditor?.refreshGhostSuggestion?.();
				requestStatusRender();
				ctx.ui.notify(`Bash mode enabled (${session.state.shellName})`, "info");
			} catch (error) {
				shellSession?.dispose();
				shellSession = null;
				bashModeActive = false;
				requestStatusRender();
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to start shell session: ${message}`, "error");
			}
			return;
		}

		bashModeActive = value;
		currentEditor?.dismissBashModeUi?.();
		requestStatusRender();
		ctx.ui.notify("Bash mode disabled", "info");
	};

	// Track session start
	pi.on("session_start", async (_event, ctx) => {
		shellSession?.dispose();
		shellSession = null;
		sessionStartTime = Date.now();
		currentCtx = ctx;
		customCompactionEnabled = detectCustomCompactionEnabled(ctx.cwd);
		lastUserPrompt = "";
		isStreaming = false;
		liveAssistantUsage = null;
		stashState.stashedEditorText = null;

		const settings = readSettings(ctx.cwd);
		bashModeSettings = parseBashModeSettings(settings);
		resolvedShortcuts = resolveShortcutConfig(settings);
		showLastPrompt = settings.showLastPrompt !== false;
		config = parsePowerlineConfig(settings.powerline, PRESET_NAMES);
		stashState.stashedPromptHistory = readPersistedStashHistory();
		bashModeActive = false;
		bashTranscript = new BashTranscriptStore(bashModeSettings);
		bashCompletionEngine = new BashCompletionEngine();

		const thinkingContext = ctx as typeof ctx & { getThinkingLevel?: () => string };
		getThinkingLevelFn =
			typeof thinkingContext.getThinkingLevel === "function"
				? () => thinkingContext.getThinkingLevel?.() ?? "off"
				: null;
		currentThinkingLevel = getThinkingLevelFn?.() ?? null;

		if (ctx.hasUI) {
			ctx.ui.setStatus("stash", undefined);
		}

		if (enabled && ctx.hasUI) {
			setupCustomEditor(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		statusRenderScheduler.cancel();
		restoreFooterStatusRepaintHook?.();
		restoreFooterStatusRepaintHook = null;
		teardownFixedEditorCompositor(fixedEditorState, { resetExtendedKeyboardModes: true });
		stashShortcutInputUnsubscribe?.();
		stashShortcutInputUnsubscribe = null;
		shellSession?.dispose();
		shellSession = null;
		bashModeActive = false;
		currentCtx = null;
		footerDataRef = null;
		getThinkingLevelFn = null;
		currentThinkingLevel = null;
		liveAssistantUsage = null;
		tuiRef = null;
		currentEditor = null;
		resetLayoutCache();
	});

	// Check if a bash command might change git branch
	const mightChangeGitBranch = (cmd: string): boolean => {
		const gitBranchPatterns = [
			/\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
			/\bgit\s+stash\s+(pop|apply)/,
		];
		return gitBranchPatterns.some((p) => p.test(cmd));
	};

	// Invalidate git status on file changes, trigger re-render on potential branch changes
	pi.on("tool_result", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			invalidateGitStatus();
		}
		// Check for bash commands that might change git branch
		if (event.toolName === "bash" && event.input?.command) {
			const cmd = String(event.input.command);
			if (mightChangeGitBranch(cmd)) {
				// Invalidate caches since working tree state changes with branch
				invalidateGitStatus();
				invalidateGitBranch();
				// Small delay to let git update, then re-render
				setTimeout(() => requestStatusRender(), 100);
			}
		}
	});

	// Also catch user escape commands (! prefix)
	// Note: This fires BEFORE execution, so we use a longer delay and multiple re-renders
	// to ensure we catch the update after the command completes.
	pi.on("user_bash", async (event) => {
		if (mightChangeGitBranch(event.command)) {
			// Invalidate immediately so next render fetches fresh data
			invalidateGitStatus();
			invalidateGitBranch();
			// Multiple staggered re-renders to catch fast and slow commands
			setTimeout(() => requestStatusRender(), 100);
			setTimeout(() => requestStatusRender(), 300);
			setTimeout(() => requestStatusRender(), 500);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		requestStatusRender();
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		currentCtx = ctx;
		currentThinkingLevel = getThinkingLevelFn?.() ?? (typeof event.level === "string" ? event.level : null);
		requestImmediateStatusRender({ deferDuringTyping: false });
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentCtx = ctx;
		currentThinkingLevel = null;
		liveAssistantUsage = null;
		requestImmediateStatusRender({ deferDuringTyping: false });
	});

	pi.on("before_agent_start", async (event) => {
		lastUserPrompt = event.prompt;
	});

	// Track streaming state (footer only shows status during streaming)
	pi.on("agent_start", async (_event, ctx) => {
		isStreaming = true;
		liveAssistantUsage = null;
		currentCtx = ctx;
	});

	pi.on("message_update", async (event, ctx) => {
		if (
			isSessionAssistantMessage(event.message) &&
			event.message.stopReason !== "error" &&
			event.message.stopReason !== "aborted" &&
			getUsageTokenTotal(event.message.usage) > 0
		) {
			liveAssistantUsage = event.message.usage;
			currentCtx = ctx;
			layoutDirty = true;
			statusRenderScheduler.schedule(CONTEXT_STATUS_RENDER_MS);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		currentCtx = ctx;
		if (isSessionAssistantMessage(event.message)) {
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				liveAssistantUsage = null;
			} else if (getUsageTokenTotal(event.message.usage) > 0) {
				liveAssistantUsage = event.message.usage;
			}
		}
		requestImmediateStatusRender({ deferDuringTyping: false });
	});

	pi.on("turn_end", async (_event, ctx) => {
		currentCtx = ctx;
		requestImmediateStatusRender({ deferDuringTyping: false });
	});

	pi.on("agent_end", async (_event, ctx) => {
		isStreaming = false;
		liveAssistantUsage = null;
		currentCtx = ctx;
		if (ctx.hasUI) {
			if (stashState.stashedEditorText !== null) {
				if (ctx.ui.getEditorText().trim() === "") {
					ctx.ui.setEditorText(stashState.stashedEditorText);
					stashState.stashedEditorText = null;
					ctx.ui.setStatus("stash", undefined);
					ctx.ui.notify("Stash restored", "info");
				} else {
					ctx.ui.notify("Stash preserved — clear editor then Alt+S to restore", "info");
				}
			}
		}
		requestStatusRender();
	});

	// Command to toggle/configure
	pi.registerCommand("powerline", {
		description: "Configure powerline status (toggle, preset)",
		handler: async (args, ctx) => {
			// Update context reference (command ctx may have more methods)
			currentCtx = ctx;

			if (!args?.trim()) {
				// Toggle
				enabled = !enabled;
				if (enabled) {
					setupCustomEditor(ctx);
					ctx.ui.notify("Powerline enabled", "info");
				} else {
					shellSession?.dispose();
					shellSession = null;
					bashTranscript.clear();
					bashModeActive = false;
					getPromptHistoryState().savedPromptHistory = [];
					stashState.stashedEditorText = null;
					ctx.ui.setStatus("stash", undefined);
					restoreFooterStatusRepaintHook?.();
					restoreFooterStatusRepaintHook = null;
					teardownFixedEditorCompositor(fixedEditorState);
					stashShortcutInputUnsubscribe?.();
					stashShortcutInputUnsubscribe = null;
					// Clear all custom UI components
					ctx.ui.setEditorComponent(undefined);
					ctx.ui.setFooter(undefined);
					ctx.ui.setHeader(undefined);
					ctx.ui.setWidget("powerline-top", undefined);
					ctx.ui.setWidget("powerline-secondary", undefined);
					ctx.ui.setWidget("powerline-bash-transcript", undefined);
					ctx.ui.setWidget("powerline-status", undefined);
					ctx.ui.setWidget("powerline-last-prompt", undefined);
					footerDataRef = null;
					tuiRef = null;
					currentEditor = null;
					statusRenderScheduler.cancel();
					resetLayoutCache();
					ctx.ui.notify("Powerline disabled", "info");
				}
				return;
			}

			const normalizedArgs = args.trim().toLowerCase();
			const mouseScrollMatch = /^mouse-scroll(?:\s+(on|off|toggle))?$/.exec(normalizedArgs);
			if (mouseScrollMatch) {
				const mode = mouseScrollMatch[1] ?? "toggle";
				config.mouseScroll = mode === "toggle" ? !config.mouseScroll : mode === "on";
				if (enabled && ctx.hasUI && config.fixedEditor && tuiRef && currentEditor) {
					installFixedEditorCompositor(fixedEditorContext, ctx, tuiRef);
				}

				if (writePowerlineOptionSetting(ctx.cwd, { mouseScroll: config.mouseScroll }, config.preset)) {
					ctx.ui.notify(`Powerline mouse scroll ${config.mouseScroll ? "enabled" : "disabled"}`, "info");
				} else {
					ctx.ui.notify(
						`Powerline mouse scroll ${config.mouseScroll ? "enabled" : "disabled"} (not persisted; check settings.json)`,
						"warning",
					);
				}
				return;
			}

			const fixedEditorMatch = /^fixed-editor(?:\s+(on|off|toggle))?$/.exec(normalizedArgs);
			if (fixedEditorMatch) {
				const mode = fixedEditorMatch[1] ?? "toggle";
				config.fixedEditor = mode === "toggle" ? !config.fixedEditor : mode === "on";
				if (enabled && ctx.hasUI) {
					setupCustomEditor(ctx);
				}

				if (writePowerlineOptionSetting(ctx.cwd, { fixedEditor: config.fixedEditor }, config.preset)) {
					ctx.ui.notify(`Powerline fixed editor ${config.fixedEditor ? "enabled" : "disabled"}`, "info");
				} else {
					ctx.ui.notify(
						`Powerline fixed editor ${config.fixedEditor ? "enabled" : "disabled"} (not persisted; check settings.json)`,
						"warning",
					);
				}
				return;
			}

			const preset = normalizePreset(args);
			if (preset) {
				config.preset = preset;
				resetLayoutCache();
				if (enabled) {
					setupCustomEditor(ctx);
				}

				if (writePowerlinePresetSetting(preset, ctx.cwd)) {
					ctx.ui.notify(`Preset set to: ${preset}`, "info");
				} else {
					ctx.ui.notify(`Preset set to: ${preset} (not persisted; check settings.json)`, "warning");
				}
				return;
			}

			// Show available presets
			const presetList = Object.keys(PRESETS).join(", ");
			ctx.ui.notify(`Available presets: ${presetList}`, "info");
		},
	});

	pi.registerCommand("stash-history", {
		description: "Open prompt history picker",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!enabled) {
				ctx.ui.notify("Powerline is disabled", "info");
				return;
			}

			await openStashHistory(ctx, stashState);
		},
	});

	pi.registerCommand("bash-mode", {
		description: "Toggle sticky bash mode (on, off, toggle)",
		handler: async (args, ctx) => {
			const mode = args?.trim().toLowerCase() || "toggle";
			if (mode === "on") {
				await setBashModeActive(true, ctx);
				return;
			}
			if (mode === "off") {
				await setBashModeActive(false, ctx);
				return;
			}
			if (mode === "toggle") {
				await setBashModeActive(!bashModeActive, ctx);
				return;
			}
			ctx.ui.notify("Usage: /bash-mode [on|off|toggle]", "warning");
		},
	});

	pi.registerCommand("bash-reset", {
		description: "Reset the managed bash session",
		handler: async (_args, ctx) => {
			shellSession?.dispose();
			shellSession = null;
			bashTranscript.clear();
			if (bashModeActive) {
				try {
					await ensureShellSession();
				} catch (error) {
					bashModeActive = false;
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to restart shell session: ${message}`, "error");
					requestStatusRender();
					return;
				}
			}
			requestStatusRender();
			ctx.ui.notify("Bash session reset", "info");
		},
	});

	pi.registerShortcut(asKeyId(bashModeSettings.toggleShortcut), {
		description: "Toggle bash mode",
		handler: async (ctx) => {
			if (!enabled || !ctx.hasUI) return;
			await setBashModeActive(!bashModeActive, ctx);
		},
	});

	pi.registerShortcut("alt+s", {
		description: "Stash/restore editor text",
		handler: async (ctx) => {
			if (!enabled || !ctx.hasUI) return;
			stashOrRestoreEditorText(ctx, stashState, currentEditor);
		},
	});

	pi.registerShortcut(asKeyId(resolvedShortcuts.stashHistory), {
		description: "Open prompt history picker",
		handler: async (ctx) => {
			if (!enabled || !ctx.hasUI) return;
			await openStashHistory(ctx, stashState);
		},
	});

	pi.registerShortcut(asKeyId(resolvedShortcuts.copyEditor), {
		description: "Copy full editor text",
		handler: async (ctx) => {
			if (!enabled || !ctx.hasUI) return;

			const text = getEditorTextForClipboard(ctx, currentEditor);
			if (!text) return;

			copyTextToClipboard(ctx, text, "Copied editor text");
		},
	});

	pi.registerShortcut(asKeyId(resolvedShortcuts.cutEditor), {
		description: "Cut full editor text",
		handler: async (ctx) => {
			if (!enabled || !ctx.hasUI) return;

			const text = getEditorTextForClipboard(ctx, currentEditor);
			if (!text) return;

			copyTextToClipboard(ctx, text);
			ctx.ui.setEditorText("");
			ctx.ui.notify("Cut editor text", "info");
		},
	});

	for (const { shortcutKey, description, action } of CHAT_JUMP_SHORTCUTS) {
		pi.registerShortcut(asKeyId(resolvedShortcuts[shortcutKey]), {
			description,
			handler: async (ctx) => {
				if (!enabled || !ctx.hasUI) return;
				runPowerlineShortcut(
					ctx,
					{ kind: "chat", action },
					stashState,
					currentEditor,
					bashModeActive,
					fixedEditorCompositor,
					tuiRef,
					setBashModeActive,
				);
			},
		});
	}

	function setupCustomEditor(ctx: any) {
		snapshotPromptHistory(currentEditor);
		if (!enabled) {
			return;
		}

		stashShortcutInputUnsubscribe?.();
		stashShortcutInputUnsubscribe =
			typeof ctx.ui.onTerminalInput === "function"
				? ctx.ui.onTerminalInput((data: string) => {
						if (!enabled || !ctx.hasUI || tuiRef?.hasOverlay?.()) {
							return undefined;
						}
						if (isStashShortcutInput(data)) {
							stashOrRestoreEditorText(ctx, stashState, currentEditor);
							tuiRef?.requestRender();
							return { consume: true };
						}

						const powerlineShortcutAction = getPowerlineShortcutAction(data, resolvedShortcuts, bashModeSettings);
						if (!powerlineShortcutAction) {
							return undefined;
						}

						runPowerlineShortcut(
							ctx,
							powerlineShortcutAction,
							stashState,
							currentEditor,
							bashModeActive,
							fixedEditorCompositor,
							tuiRef,
							setBashModeActive,
						);
						tuiRef?.requestRender();
						return { consume: true };
					})
				: null;

		teardownFixedEditorCompositor(fixedEditorState);
		ctx.ui.setWidget("powerline-top", undefined);
		ctx.ui.setWidget("powerline-secondary", undefined);
		ctx.ui.setWidget("powerline-bash-transcript", undefined);
		ctx.ui.setWidget("powerline-status", undefined);
		ctx.ui.setWidget("powerline-last-prompt", undefined);

		let autocompleteFixed = false;

		const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
			const editor = new BashModeEditor(tui, editorTheme, keybindings, {
				keybindings,
				isBashModeActive: () => bashModeActive,
				isShellRunning: () => shellSession?.state.running ?? false,
				onExitBashMode: () => {
					void setBashModeActive(false, ctx);
				},
				onSubmitCommand: (command) => void runShellCommand(command, ctx),
				onEditorSubmit: () => followSubmittedEditorToBottom(fixedEditorState.compositor),
				editorBoundaryShortcuts: {
					start: resolvedShortcuts.editorStart,
					end: resolvedShortcuts.editorEnd,
				},
				onInterrupt: () => {
					shellSession?.interrupt();
					ctx.ui.notify("Sent interrupt to shell", "info");
				},
				onNotify: (message, level = "info") => ctx.ui.notify(message, level),
				getHistoryEntries: (prefix) => getShellHistoryEntries(prefix),
				resolveGhostSuggestion: async (text, signal) => {
					const oneOffBash = getOneOffBashCommandContext(text);
					if (oneOffBash) {
						const ghost = await bashCompletionEngine.getGhostSuggestion(
							oneOffBash.command,
							getShellCwd(),
							getShellPath(),
							signal,
						);
						return ghost ? { ...ghost, value: `${oneOffBash.prefix}${ghost.value}` } : null;
					}

					return bashCompletionEngine.getGhostSuggestion(text, getShellCwd(), getShellPath(), signal);
				},
			});

			const getInstalledAutocompleteProvider = (): AutocompleteProvider | undefined => {
				const candidate = Reflect.get(editor, "autocompleteProvider");
				if (!candidate || typeof candidate !== "object") {
					return undefined;
				}
				if (typeof Reflect.get(candidate, "getSuggestions") !== "function") {
					return undefined;
				}
				if (typeof Reflect.get(candidate, "applyCompletion") !== "function") {
					return undefined;
				}
				return candidate;
			};

			const attachAutocompleteProvider = (): boolean => {
				if (editor.hasWrappedProvider()) return true;
				const defaultProvider = getInstalledAutocompleteProvider();
				if (!defaultProvider) return false;

				const bashProvider = new BashAutocompleteProvider();
				const oneOffBashProvider = new OneOffBashAutocompleteProvider();
				editor.installAutocompleteProvider(
					new ModeAwareAutocompleteProvider(
						defaultProvider,
						bashProvider,
						oneOffBashProvider,
						() => bashModeActive,
					),
				);
				return true;
			};

			let inheritedOnSubmit: unknown;
			Object.defineProperty(editor, "onSubmit", {
				configurable: true,
				get: () => inheritedOnSubmit,
				set(handler: unknown) {
					inheritedOnSubmit =
						typeof handler === "function"
							? (text: string) => {
									followSubmittedEditorToBottom(fixedEditorState.compositor);
									handler(text);
								}
							: handler;
				},
			});

			currentEditor = editor;
			trackPromptHistory(editor);
			restorePromptHistory(editor);
			attachAutocompleteProvider();

			const originalHandleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				lastEditorInputAt = Date.now();

				if (isStashShortcutInput(data)) {
					stashOrRestoreEditorText(ctx, stashState, currentEditor);
					return;
				}

				const powerlineShortcutAction = getPowerlineShortcutAction(data, resolvedShortcuts, bashModeSettings);
				if (powerlineShortcutAction) {
					runPowerlineShortcut(
						ctx,
						powerlineShortcutAction,
						stashState,
						currentEditor,
						bashModeActive,
						fixedEditorCompositor,
						tuiRef,
						setBashModeActive,
					);
					return;
				}

				if (!autocompleteFixed && !getInstalledAutocompleteProvider()) {
					autocompleteFixed = true;
					snapshotPromptHistory(editor);
					ctx.ui.setEditorComponent(editorFactory);
					if (config.fixedEditor) {
						installFixedEditorCompositor(fixedEditorContext, ctx, tui);
					}
					currentEditor?.handleInput(data);
					return;
				}

				attachAutocompleteProvider();
				const followUpText = keybindings.matches(data, "app.message.followUp")
					? getCurrentEditorText(ctx, editor)
					: "";
				originalHandleInput(data);
				if (hasNonWhitespaceText(followUpText) && !hasNonWhitespaceText(getCurrentEditorText(ctx, editor))) {
					followSubmittedEditorToBottom(fixedEditorState.compositor);
				}
			};

			const originalRender = editor.render.bind(editor);
			editor.render = (width: number): string[] => {
				if (width < 10) {
					return originalRender(width);
				}

				const bc = (s: string) => `${getFgAnsiCode("sep")}${s}${ansi.reset}`;
				const promptGlyph = bashModeActive ? "$" : ">";
				const prompt = `${ansi.getFgAnsi(200, 200, 200)}${promptGlyph}${ansi.reset}`;
				const promptPrefix = ` ${prompt} `;
				const contPrefix = "   ";
				const contentWidth = Math.max(1, width - 3);
				const lines = originalRender(contentWidth);

				if (lines.length === 0) return lines;

				let bottomBorderIndex = lines.length - 1;
				for (let i = lines.length - 1; i >= 1; i--) {
					const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
					if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
						bottomBorderIndex = i;
						break;
					}
				}

				const result: string[] = [];
				result.push(" " + bc("─".repeat(width - 2)));

				for (let i = 1; i < bottomBorderIndex; i++) {
					const prefix = i === 1 ? promptPrefix : contPrefix;
					result.push(`${prefix}${lines[i] || ""}`);
				}

				if (bottomBorderIndex === 1) {
					result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
				}

				result.push(" " + bc("─".repeat(width - 2)));

				for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
					result.push(lines[i] || "");
				}

				return result;
			};

			return editor;
		};

		ctx.ui.setEditorComponent(editorFactory);

		ctx.ui.setFooter((tui: any, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			footerDataRef = footerData;
			tuiRef = tui;
			installFooterStatusRepaintHook(footerData);
			const unsub = footerData.onBranchChange(() => requestStatusRender());

			return {
				dispose() {
					unsub();
					restoreFooterStatusRepaintHook?.();
					restoreFooterStatusRepaintHook = null;
				},
				invalidate() {
					requestStatusRender();
				},
				render(): string[] {
					return [];
				},
			};
		});

		if (config.fixedEditor) {
			if (tuiRef) {
				installFixedEditorCompositor(fixedEditorContext, ctx, tuiRef);
			}
		} else {
			installPowerlineWidgets(fixedEditorContext, ctx);
		}
	}
}
