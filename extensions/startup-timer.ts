import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, Key, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------
function normalizeP(p: string): string { return p.replace(/\\/g, "/"); }

function fileUrlToPath(url: string): string {
	const u = new URL(url);
	if (u.protocol !== "file:") return "";
	return decodeURIComponent(u.pathname).replace(/^\//, "");
}

function srcPath(si: unknown): string | undefined {
	if (!si || typeof si !== "object") return undefined;
	const r = si as Record<string, unknown>;
	return typeof r.path === "string" ? r.path : undefined;
}

// Extract a meaningful display name from an extension path.
// npm packages → package name   (e.g. @scope/name or package-name)
// dir extensions → dir name     (e.g. pi-mcp-adapter/index.ts → pi-mcp-adapter)
// file extensions → filename    (e.g. files.ts → files)
function makeLabel(path: string): string {
	const n = normalizeP(path);

	// npm package
	const nm = n.lastIndexOf("/node_modules/");
	if (nm !== -1) {
		const after = n.slice(nm + 14);
		const parts = after.split("/");
		if (parts[0].startsWith("@")) {
			return parts[0] + "/" + (parts[1] ?? "");
		}
		return parts[0];
	}

	const name = basename(n);
	const isIndex = /^index\.(ts|js|mjs)$/i.test(name);
	if (isIndex) {
		// Walk up past src/dist/__pycache__ to get the real module name
		let dir = dirname(n);
		let parent = basename(dir);
		while (["src", "dist", "lib", "build"].includes(parent) && dir !== dirname(dir)) {
			dir = dirname(dir);
			parent = basename(dir);
		}
		return parent;
	}

	return name.replace(/\.(ts|js|mjs)$/i, "") || n;
}

function fmtMs(v: number): string {
	if (v <= 0) return "-";
	if (v < 1000) return `${v}ms`;
	return `${(v / 1000).toFixed(2)}s`;
}

// -----------------------------------------------------------------
// Extension detection
// -----------------------------------------------------------------
interface ExtEntry {
	path: string;
	label: string;
}

function detectExtensions(pi: ExtensionAPI): ExtEntry[] {
	const seen = new Set<string>();
	const result: ExtEntry[] = [];

	const selfFile = normalizeP(fileUrlToPath(import.meta.url));

	const add = (path: string | undefined) => {
		if (!path || path.startsWith("<builtin:")) return;
		const n = normalizeP(path);
		if (n === selfFile || seen.has(n)) return;
		if (!existsSync(n)) return;
		seen.add(n);
		result.push({ path: n, label: makeLabel(n) });
	};

	// From the API
	try { for (const t of pi.getAllTools()) add(srcPath(t.sourceInfo)); } catch { /* nop */ }
	try {
		for (const c of pi.getCommands()) {
			if (c.source === "extension") add(srcPath(c.sourceInfo));
		}
	} catch { /* nop */ }
	return result;
}

// -----------------------------------------------------------------
// Spawn pi processes
// -----------------------------------------------------------------
interface ProcResult {
	ms: number;
	error?: string;
}

function parseTotal(stderr: string): number {
	const m = stderr.match(/^\s+TOTAL:\s+(\d+)ms/m);
	if (m) return parseInt(m[1], 10);
	const m2 = stderr.match(/^\s+TOTAL:\s+(\d+\.\d+)ms/m);
	if (m2) return Math.round(parseFloat(m2[1]));
	return 0;
}

async function spawnPi(args: string[], timeoutMs: number): Promise<ProcResult> {
	return new Promise((resolve) => {
		const env = { ...process.env, PI_TIMING: "1" };
		const piScript = process.argv[1];
		const directOk = Boolean(piScript && existsSync(piScript) && statSync(piScript).isFile());
		const cmd = directOk ? process.execPath : "pi";
		const cmdArgs = directOk ? [piScript!, ...args] : args;
		const proc = spawn(cmd, cmdArgs, {
			env,
			shell: !directOk,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		const timer = setTimeout(() => { proc.kill(); resolve({ ms: 0, error: "timeout" }); }, timeoutMs);
		proc.on("error", (err) => { clearTimeout(timer); resolve({ ms: 0, error: String(err.message ?? err) }); });
		proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ ms: parseTotal(stderr), error: code !== 0 ? `exit=${code}` : undefined });
		});
	});
}

async function measureBaseline(timeoutMs: number): Promise<ProcResult> {
	return spawnPi(["--no-extensions", "-p", "exit"], timeoutMs);
}

async function measureOne(ext: ExtEntry, timeoutMs: number): Promise<{ label: string; ms: number; error?: string }> {
	const r = await spawnPi(["--no-extensions", "-e", ext.path, "-p", "exit"], timeoutMs);
	return { label: ext.label, ms: r.ms, error: r.error };
}

// -----------------------------------------------------------------
// Report Viewer — centered overlay with wrap + arrow scroll
// -----------------------------------------------------------------
class ReportViewer implements Component {
	private source: string[];
	private display: string[] = [];
	private scrollOffset = 0;
	private visibleHeight = 0;
	private cachedWidth = 0;
	private cache: string[] = [];
	private onDone: () => void;

	constructor(source: string[], onDone: () => void) {
		this.source = source;
		this.onDone = onDone;
	}

	private recalc(innerW: number): void {
		const flat: string[] = [];
		for (const line of this.source) {
			if (line.length === 0) { flat.push(""); continue; }
			flat.push(...wrapTextWithAnsi(line, innerW));
		}
		this.display = flat;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.enter)) {
			this.onDone();
			return;
		}
		const max = Math.max(0, this.display.length - this.visibleHeight);
		let changed = false;
		if (matchesKey(data, Key.up) && this.scrollOffset > 0) { this.scrollOffset--; changed = true; }
		if (matchesKey(data, Key.down) && this.scrollOffset < max) { this.scrollOffset++; changed = true; }
		if (matchesKey(data, Key.pageUp)) {
			const s = Math.max(1, this.visibleHeight - 2);
			const p = this.scrollOffset;
			this.scrollOffset = Math.max(0, this.scrollOffset - s);
			if (this.scrollOffset !== p) changed = true;
		}
		if (matchesKey(data, Key.pageDown)) {
			const s = Math.max(1, this.visibleHeight - 2);
			const p = this.scrollOffset;
			this.scrollOffset = Math.min(max, this.scrollOffset + s);
			if (this.scrollOffset !== p) changed = true;
		}
		if (matchesKey(data, Key.home)) { if (this.scrollOffset !== 0) { this.scrollOffset = 0; changed = true; } }
		if (matchesKey(data, Key.end)) { if (this.scrollOffset !== max) { this.scrollOffset = max; changed = true; } }
		if (changed) this.invalidate();
	}

	render(width: number): string[] {
		const innerW = width - 4;
		this.visibleHeight = Math.max(3, Math.floor((process.stdout.rows ?? 24) * 0.7) - 2);
		if (this.cachedWidth === width && this.cache.length > 0) return this.cache;
		this.cachedWidth = width;
		this.recalc(Math.max(10, innerW));

		const total = this.display.length;
		const max = Math.max(0, total - this.visibleHeight);
		this.scrollOffset = Math.min(this.scrollOffset, max);

		const result: string[] = [];
		result.push("┌" + "─".repeat(width - 2) + "┐");
		const end = Math.min(this.scrollOffset + this.visibleHeight, total);
		for (let i = this.scrollOffset; i < end; i++) {
			const raw = this.display[i];
			const text = ("  " + raw).padEnd(width - 4);
			result.push("│ " + text + " │");
		}
		for (let i = end - this.scrollOffset; i < this.visibleHeight; i++) {
			result.push("│" + " ".repeat(width - 2) + "│");
		}
		const atTop = this.scrollOffset === 0;
		const atBottom = this.scrollOffset >= max;
		let status = "";
		if (total > this.visibleHeight) {
			const s = this.scrollOffset + 1;
			const e = Math.min(s + this.visibleHeight - 1, total);
			if (atTop) status = ` ${s}-${e}/${total} v`;
			else if (atBottom) status = ` ${s}-${e}/${total} ^`;
			else status = ` ${s}-${e}/${total} ^v`;
		}
		result.push("└" + "─".repeat(width - 2 - status.length) + status + "┘");
		this.cache = result;
		return result;
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.display = [];
		this.cache = [];
	}
}

// -----------------------------------------------------------------
// Output
// -----------------------------------------------------------------
function buildOutput(
	items: Array<{ label: string; ms: number; error?: string }>,
	baselineMs: number,
	baselineErr: string | undefined,
	elapsedSec: number,
): string[] {
	const lines: string[] = [];
	lines.push("Extension Startup Profiler");
	lines.push("");
	const baseStr = baselineErr ? `failed (${baselineErr})` : fmtMs(baselineMs);
	lines.push(`  Baseline (bare Pi)   ${baseStr}`);
	lines.push("");

	// Sort by overhead (ms - baselineMs) descending
	const sorted = [...items]
		.map((r) => ({
			label: r.label,
			total: r.ms,
			overhead: r.ms > baselineMs ? r.ms - baselineMs : 0,
			error: r.error,
		}))
		.sort((a, b) => b.overhead - a.overhead);

	// Column widths
	const maxNameLen = Math.max(...sorted.map((r) => r.label.length), 20);
	const nameCol = maxNameLen + 2;

	lines.push(`  ${"Extension".padEnd(nameCol)}  Overhead    Total`);
	lines.push(`  ${"".padEnd(nameCol, "─")}  ─────────  ─────────`);
	for (const r of sorted) {
		if (r.error) {
			lines.push(`  ${r.label.padEnd(nameCol)}  error: ${r.error}`);
		} else {
			const oh = r.overhead > 0 ? fmtMs(r.overhead) : "-";
			const tot = r.total > 0 ? fmtMs(r.total) : "-";
			lines.push(`  ${r.label.padEnd(nameCol)}  ${oh.padStart(8)}  ${tot.padStart(8)}`);
		}
	}

	lines.push("");
	const ok = items.filter((r) => !r.error).length;
	const failed = items.filter((r) => r.error).length;
	lines.push(`  ${items.length} extensions  |  ${ok} ok, ${failed} failed  |  ${elapsedSec.toFixed(1)}s`);
	lines.push("");
	lines.push("  Close: Esc/q/Enter  Scroll: arrows  PgUp/PgDn  Home/End");
	return lines;
}

// -----------------------------------------------------------------
// Main
// -----------------------------------------------------------------
function showOverlay(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	const exts = detectExtensions(pi);
	if (exts.length === 0) {
		ctx.ui.notify("No file-based extensions found.", "warning");
		return;
	}

	const startTime = Date.now();
	ctx.ui.notify(`Probing ${exts.length} extensions (${exts.length + 1} Pi processes)...`, "info");

	(async () => {
		try {
			const baseline = await measureBaseline(120000);
			const promises = exts.map((ext) => measureOne(ext, 120000));
			const results = await Promise.all(promises);
			const elapsedSec = (Date.now() - startTime) / 1000;
			const lines = buildOutput(results, baseline.ms, baseline.error, elapsedSec);

			ctx.ui.custom<string | null>(
				(_tui, _theme, _keybindings, done) => new ReportViewer(lines, () => done(null)),
				{
					overlay: true,
					overlayOptions: {
						width: "78%",
						minWidth: 44,
						maxHeight: "70%",
						anchor: "center",
					},
				},
			).catch(() => {});
		} catch (err) {
			ctx.ui.notify(`Error: ${String(err)}`, "error");
		}
	})().catch((err) => {
		ctx.ui.notify(`Error: ${String(err)}`, "error");
	});
}

export default function startupTimerExt(pi: ExtensionAPI) {
	pi.registerCommand("startup-time", {
		description: "Measure each extension's startup overhead via parallel Pi subprocesses",
		handler: async (_args, ctx) => {
			showOverlay(pi, ctx);
		},
	});
}
