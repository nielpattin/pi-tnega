import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";

interface UsageEntry {
	type?: unknown;
	timestamp?: unknown;
	message?: {
		role?: unknown;
		provider?: unknown;
		model?: unknown;
		usage?: {
			input?: unknown;
			output?: unknown;
			cacheRead?: unknown;
			cacheWrite?: unknown;
			totalTokens?: unknown;
			cost?: { total?: unknown };
		};
	};
}

export interface DailyUsageRow {
	date: string;
	msgs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	provider: string;
	model: string;
}

type DailyAccumulator = DailyUsageRow;

interface UsageFilters {
	providers?: string[];
	models?: string[];
}

interface UsageDataset {
	entries: UsageEntry[];
	filesRead: number;
	filesSkipped: number;
	linesSkipped: number;
	providers: string[];
	models: string[];
}

interface UsageScanResult {
	rows: DailyUsageRow[];
	filesRead: number;
	filesSkipped: number;
	linesSkipped: number;
	providers: string[];
	models: string[];
	filters: UsageFilters;
}

interface RenderRow {
	date: string;
	msgs: string;
	input: string;
	output: string;
	cacheRead: string;
	cacheWrite: string;
	total: string;
	cost: string;
	provider: string;
	model: string;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function localDateKey(timestamp: unknown): string | null {
	if (typeof timestamp !== "string" && typeof timestamp !== "number") return null;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleDateString("en-CA");
}

export function aggregateUsageEntries(entries: UsageEntry[]): DailyUsageRow[] {
	const byDate = new Map<string, DailyAccumulator>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (!usage) continue;

		const date = localDateKey(entry.timestamp);
		if (!date) continue;

		const provider = typeof entry.message.provider === "string" && entry.message.provider.length > 0 ? entry.message.provider : "?";
		const model = typeof entry.message.model === "string" && entry.message.model.length > 0 ? entry.message.model : "?";
		const key = `${date}\u0000${provider}\u0000${model}`;

		let row = byDate.get(key);
		if (!row) {
			row = {
				date,
				msgs: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
				cost: 0,
				provider,
				model,
			};
			byDate.set(key, row);
		}

		row.msgs += 1;
		row.input += numberValue(usage.input);
		row.output += numberValue(usage.output);
		row.cacheRead += numberValue(usage.cacheRead);
		row.cacheWrite += numberValue(usage.cacheWrite);
		row.total += numberValue(usage.totalTokens);
		row.cost += numberValue(usage.cost?.total);
	}

	return Array.from(byDate.values()).sort((a, b) =>
		b.date.localeCompare(a.date) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
	);
}

async function listJsonlFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return files;
	}

	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listJsonlFiles(path)));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(path);
		}
	}
	return files;
}

async function loadUsageDataset(): Promise<UsageDataset> {
	const sessionRoot = join(homedir(), ".pi", "agent", "sessions");
	const files = await listJsonlFiles(sessionRoot);
	const entries: UsageEntry[] = [];
	const providers = new Set<string>();
	const models = new Set<string>();
	let filesRead = 0;
	let filesSkipped = 0;
	let linesSkipped = 0;

	for (const file of files) {
		let text: string;
		try {
			text = await readFile(file, "utf8");
			filesRead += 1;
		} catch {
			filesSkipped += 1;
			continue;
		}

		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as UsageEntry;
				if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;
				if (typeof entry.message.provider === "string" && entry.message.provider.length > 0) {
					providers.add(entry.message.provider);
				}
				if (typeof entry.message.model === "string" && entry.message.model.length > 0) {
					models.add(entry.message.model);
				}
				entries.push(entry);
			} catch {
				linesSkipped += 1;
			}
		}
	}

	return {
		entries,
		filesRead,
		filesSkipped,
		linesSkipped,
		providers: Array.from(providers).sort(),
		models: Array.from(models).sort(),
	};
}

function filterUsage(dataset: UsageDataset, filters: UsageFilters = {}): UsageScanResult {
	const filteredEntries = dataset.entries.filter((entry) => {
		if (filters.providers && !filters.providers.includes(String(entry.message?.provider))) return false;
		if (filters.models && !filters.models.includes(String(entry.message?.model))) return false;
		return true;
	});
	const models = new Set<string>();
	for (const entry of filteredEntries) {
		if (typeof entry.message?.model === "string" && entry.message.model.length > 0) {
			models.add(entry.message.model);
		}
	}
	return {
		rows: aggregateUsageEntries(filteredEntries),
		filesRead: dataset.filesRead,
		filesSkipped: dataset.filesSkipped,
		linesSkipped: dataset.linesSkipped,
		providers: dataset.providers,
		models: Array.from(models).sort(),
		filters,
	};
}

function formatInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatCost(value: number): string {
	return `$${value.toFixed(4)}`;
}

function fit(value: string, width: number, align: "left" | "right" | "center" = "left"): string {
	const plain = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
	if (align === "right") return plain.padStart(width);
	if (align === "center") {
		const left = Math.floor((width - plain.length) / 2);
		return `${" ".repeat(Math.max(0, left))}${plain}`.padEnd(width);
	}
	return plain.padEnd(width);
}

function frame(lines: string[], width: number): string[] {
	const innerWidth = Math.max(20, width - 4);
	return [
		`╭${"─".repeat(innerWidth + 2)}╮`,
		...lines.map((line) => `│ ${fit(line, innerWidth)} │`),
		`╰${"─".repeat(innerWidth + 2)}╯`,
	];
}

function formatFilter(label: string, values: string[] | undefined): string {
	if (!values || values.length === 0) return `all ${label}`;
	if (values.length <= 2) return `${label} ${values.join(", ")}`;
	return `${label} ${values.slice(0, 2).join(", ")} +${values.length - 2}`;
}

class MultiSelectModal implements Component {
	private cursor = 0;
	private scroll = 0;
	private readonly selected: Set<string>;

	constructor(
		private readonly title: string,
		private readonly options: string[],
		initialSelected: string[],
		private readonly done: (value: string[] | undefined) => void,
		private readonly theme: { bold: (text: string) => string; fg: (name: "accent", text: string) => string },
	) {
		this.selected = new Set(initialSelected);
	}

	render(width: number): string[] {
		const boxWidth = Math.min(Math.max(56, width - 8), 92);
		const visibleCount = 16;
		const visible = this.options.slice(this.scroll, this.scroll + visibleCount);
		const title = this.theme.fg("accent", this.theme.bold(this.title));
		const help = "Space toggle · a all · n none · Enter confirm · Esc cancel";
		const body = visible.length > 0 ? visible.map((option, index) => {
			const absoluteIndex = this.scroll + index;
			const pointer = absoluteIndex === this.cursor ? "›" : " ";
			const checked = this.selected.has(option) ? "✓" : " ";
			return `${pointer} [${checked}] ${option}`;
		}) : ["No options found."];
		const lines = [
			fit(title, boxWidth - 4, "center"),
			fit(help, boxWidth - 4, "center"),
			`selected ${this.selected.size}/${this.options.length}`,
			"─".repeat(boxWidth - 4),
			...body,
		];
		return frame(lines, boxWidth).map((line) => line.slice(0, width));
	}

	handleInput(data: string): void {
		if (data === "\u001b") {
			this.done(undefined);
			return;
		}
		if (data === "\r" || data === "\n") {
			this.done(Array.from(this.selected));
			return;
		}
		const option = this.options[this.cursor];
		if (data === " " && option) {
			if (this.selected.has(option)) this.selected.delete(option);
			else this.selected.add(option);
			return;
		}
		if (data === "a") {
			for (const item of this.options) this.selected.add(item);
			return;
		}
		if (data === "n") {
			this.selected.clear();
			return;
		}
		if (data === "\u001b[B") {
			this.cursor = Math.min(Math.max(0, this.options.length - 1), this.cursor + 1);
			this.scroll = Math.max(this.scroll, this.cursor - 15);
		} else if (data === "\u001b[A") {
			this.cursor = Math.max(0, this.cursor - 1);
			this.scroll = Math.min(this.scroll, this.cursor);
		}
	}

	invalidate(): void {}
}

async function pickMany(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string[] | undefined> {
	if (options.length === 0) return [];
	return await ctx.ui.custom<string[] | undefined>(
		(_tui, theme, _kb, done) => new MultiSelectModal(title, options, options, done, theme),
		{
			overlay: true,
			overlayOptions: {
				width: "60%",
				minWidth: 60,
				maxHeight: "80%",
				anchor: "center",
				margin: 2,
			},
		},
	);
}

class StatsModal implements Component {
	private scroll = 0;

	constructor(
		private readonly result: UsageScanResult,
		private readonly done: () => void,
		private readonly theme: { bold: (text: string) => string; fg: (name: "accent", text: string) => string },
	) {}

	render(width: number): string[] {
		const tableWidth = Math.min(Math.max(96, width - 6), 150);
		const rows = this.result.rows;
		const filterLabel = [
			formatFilter("providers", this.result.filters.providers),
			formatFilter("models", this.result.filters.models),
		].join(" · ");
		const title = this.theme.fg("accent", this.theme.bold("Daily token usage"));
		const subtitle = `${rows.length} days · ${this.result.filesRead} files · ${filterLabel}`;
		const help = "q/Esc/Enter closes · ↑/↓ scroll";
		const warnings = [];
		if (this.result.filesSkipped > 0) warnings.push(`${this.result.filesSkipped} files skipped`);
		if (this.result.linesSkipped > 0) warnings.push(`${this.result.linesSkipped} lines skipped`);

		const header = this.renderRow({
			date: "date",
			msgs: "msgs",
			input: "input",
			output: "output",
			cacheRead: "cache r",
			cacheWrite: "cache write",
			total: "total",
			cost: "cost",
			provider: "provider",
			model: "model",
		});
		const visibleRows = rows.slice(this.scroll, this.scroll + 30).map((row) =>
			this.renderRow({
				date: row.date,
				msgs: formatInt(row.msgs),
				input: formatInt(row.input),
				output: formatInt(row.output),
				cacheRead: formatInt(row.cacheRead),
				cacheWrite: formatInt(row.cacheWrite),
				total: formatInt(row.total),
				cost: formatCost(row.cost),
				provider: row.provider,
				model: row.model,
			}),
		);

		const lines = [
			fit(title, tableWidth - 4, "center"),
			fit(subtitle, tableWidth - 4, "center"),
			fit(help, tableWidth - 4, "center"),
			...(warnings.length > 0 ? [fit(warnings.join(" · "), tableWidth - 4, "center")] : []),
			"─".repeat(Math.min(tableWidth - 4, header.length)),
			header,
			"─".repeat(Math.min(tableWidth - 4, header.length)),
			...(visibleRows.length > 0 ? visibleRows : ["No Pi usage entries found."]),
		];
		return frame(lines, tableWidth).map((line) => line.slice(0, width));
	}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b" || data === "\r" || data === "\n") {
			this.done();
			return;
		}
		if (data === "\u001b[B") {
			this.scroll = Math.min(Math.max(0, this.result.rows.length - 1), this.scroll + 1);
		} else if (data === "\u001b[A") {
			this.scroll = Math.max(0, this.scroll - 1);
		}
	}

	invalidate(): void {}

	private renderRow(row: RenderRow): string {
		return [
			fit(row.date, 10),
			fit(row.msgs, 6, "right"),
			fit(row.input, 11, "right"),
			fit(row.output, 10, "right"),
			fit(row.cacheRead, 10, "right"),
			fit(row.cacheWrite, 12, "right"),
			fit(row.total, 11, "right"),
			fit(row.cost, 10, "right"),
			fit(row.provider, 16),
			fit(row.model, 24),
		].join(" ");
	}
}

export default function statsExtension(pi: ExtensionAPI) {
	pi.registerCommand("stats", {
		description: "Show daily token usage across all Pi sessions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const dataset = await loadUsageDataset();
			const allUsage = filterUsage(dataset);
			const selectedProviders = await pickMany(ctx, "Stats providers", allUsage.providers);
			if (selectedProviders === undefined) return;

			const providerFilter = selectedProviders.length === allUsage.providers.length ? undefined : selectedProviders;
			const providerUsage = filterUsage(dataset, { providers: providerFilter });
			const selectedModels = await pickMany(ctx, "Stats models", providerUsage.models);
			if (selectedModels === undefined) return;

			const modelFilter = selectedModels.length === providerUsage.models.length ? undefined : selectedModels;
			const result = filterUsage(dataset, { providers: providerFilter, models: modelFilter });
			await ctx.ui.custom<void>(
				(_tui, theme, _kb, done) => new StatsModal(result, done, theme),
				{
					overlay: true,
					overlayOptions: {
						width: "90%",
						minWidth: 100,
						maxHeight: "92%",
						anchor: "center",
						margin: 2,
					},
				},
			);
		},
	});
}
