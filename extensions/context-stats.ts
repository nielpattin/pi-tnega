/**
 * Context Stats Extension
 *
 * Shows current context token usage in the status bar:
 *   CTX: 42K
 *
 * Color-coded by severity:
 *   - dim:    < 70%
 *   - yellow: 70-90%
 *   - red:    > 90%
 *
 * /context for a detailed breakdown.
 *
 * Updates on session_start, turn_end, and after assistant messages.
 * Also registers /context command for a detailed breakdown.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

export default function (pi: ExtensionAPI) {
	function updateStatus(ctx: any) {
		const usage = ctx.getContextUsage?.();
		if (!usage) return;

		const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const contextUsed = typeof usage.tokens === "number" ? usage.tokens : 0;
		const percent =
			typeof usage.percent === "number"
				? usage.percent
				: contextWindow > 0
					? (contextUsed / contextWindow) * 100
					: 0;

		const theme = ctx.ui.theme;
		const usedStr = formatTokens(contextUsed);

		let text: string;
		if (percent > 90) {
			text = theme.fg("error", `CTX: ${usedStr}`);
		} else if (percent > 70) {
			text = theme.fg("warning", `CTX: ${usedStr}`);
		} else {
			text = theme.fg("muted", `CTX: ${usedStr}`);
		}

		ctx.ui.setStatus("context-stats", text);
	}

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			updateStatus(ctx);
		}
	});

	pi.registerCommand("context", {
		description: "Show detailed context token stats",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage?.();
			if (!usage) {
				ctx.ui.notify("No context usage data available", "warning");
				return;
			}

			const contextWindow = usage.contextWindow ?? (ctx as any).model?.contextWindow ?? 0;
			const contextUsed = typeof usage.tokens === "number" ? usage.tokens : 0;
			const percent =
				typeof usage.percent === "number"
					? usage.percent
					: contextWindow > 0
						? (contextUsed / contextWindow) * 100
						: 0;

			const lines = [
				`CTX: ${formatTokens(contextUsed)}`,
				`Max: ${contextWindow.toLocaleString()}`,
				`Usage: ${percent.toFixed(2)}%`,
				`Remaining: ${(contextWindow - contextUsed).toLocaleString()}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
