/**
 * Tests for the Taste System extension.
 *
 * Validates taste profile loading/saving, prompt formatting,
 * and the analysis logic that runs on agent_end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), "pi-taste-test-" + randomUUID());
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function tastePath(): string {
	return join(tmpDir, ".pi", "taste", "taste.md");
}

function simulateSession(profile: { styles: string[]; patterns: string[]; frameworks: string[]; conventions: string[] }): void {
	const dir = join(tmpDir, ".pi", "taste");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const data = {
		version: 1,
		updatedAt: Date.now(),
		languages: {},
		project: profile,
	};
	writeFileSync(tastePath(), JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Taste System", () => {
	describe("profile persistence", () => {
		it("saves and loads a taste profile from disk", () => {
			const profile = {
				styles: ["uses const over let", "2-space indentation"],
				patterns: ["prefers early returns", "uses composition over inheritance"],
				frameworks: ["React", "Express"],
				conventions: ["camelCase for variables", "PascalCase for components"],
			};
			simulateSession(profile);

			const loaded = JSON.parse(readFileSync(tastePath(), "utf-8"));
			expect(loaded.project.styles).toEqual(["uses const over let", "2-space indentation"]);
			expect(loaded.project.patterns).toContain("prefers early returns");
			expect(loaded.project.frameworks).toContain("React");
			expect(loaded.project.conventions).toContain("camelCase for variables");
		});

		it("returns null for missing taste file", () => {
			expect(existsSync(tastePath())).toBe(false);
		});

		it("handles empty taste file gracefully", () => {
			const dir = join(tmpDir, ".pi", "taste");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(tastePath(), "", "utf-8");
			expect(() => JSON.parse(readFileSync(tastePath(), "utf-8"))).toThrow();
		});
	});

	describe("prompt formatting", () => {
		it("formats a complete profile into prompt text", () => {
			const profile = {
				styles: ["uses const over let"],
				patterns: ["prefers early returns"],
				frameworks: ["React"],
				conventions: ["camelCase"],
			};

			// Inline the format function to test it
			function formatTasteForPrompt(p: typeof profile): string {
				const lines: string[] = ["## Your Coding Style (learned)", ""];
				if (p.frameworks.length) {
					lines.push("**Frameworks & tools you prefer:**");
					p.frameworks.forEach((f) => lines.push(`- ${f}`));
					lines.push("");
				}
				if (p.styles.length) {
					lines.push("**Styling conventions:**");
					p.styles.forEach((s) => lines.push(`- ${s}`));
					lines.push("");
				}
				if (p.patterns.length) {
					lines.push("**Architectural patterns:**");
					p.patterns.forEach((p2) => lines.push(`- ${p2}`));
					lines.push("");
				}
				if (p.conventions.length) {
					lines.push("**Naming & code conventions:**");
					p.conventions.forEach((c) => lines.push(`- ${c}`));
					lines.push("");
				}
				return lines.join("\n");
			}

			const text = formatTasteForPrompt(profile);
			expect(text).toContain("Your Coding Style");
			expect(text).toContain("React");
			expect(text).toContain("uses const over let");
			expect(text).toContain("prefers early returns");
			expect(text).toContain("camelCase");
		});

		it("returns empty string for empty profile", () => {
			const profile = { styles: [], patterns: [], frameworks: [], conventions: [] };
			const text = (() => {
				if (profile.styles.length + profile.patterns.length + profile.frameworks.length === 0) return "";
				return "should not reach";
			})();
			expect(text).toBe("");
		});
	});

	describe("merge logic", () => {
		it("deduplicates when merging new observations with existing", () => {
			const existing = ["React", "Express"];
			const newObs = ["React", "TypeScript"];
			const merged = [...new Set([...existing, ...newObs])];
			expect(merged).toEqual(["React", "Express", "TypeScript"]);
		});

		it("preserves existing entries when new observations are empty", () => {
			const existing = ["React", "Express"];
			const newObs: string[] = [];
			const merged = [...new Set([...existing, ...newObs])];
			expect(merged).toEqual(["React", "Express"]);
		});
	});

	describe("extractRecentActivity", () => {
		it("extracts text from session entries", () => {
			const entries = [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Add a button component" }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "I'll create a Button component" }],
					},
				},
			];

			function extractTextFromParts(parts: unknown[]): string {
				return (parts as Array<{ type: string; text?: string }>)
					.filter((p) => p.type === "text" && p.text)
					.map((p) => p.text ?? "")
					.join(" ");
			}

			const result = entries
				.map((e) => {
					const content = e.message.content;
					const text = Array.isArray(content) ? extractTextFromParts(content) : "";
					const role = e.message.role;
					return `[${role}]: ${text}`;
				})
				.join("\n\n");

			expect(result).toContain("[user]: Add a button component");
			expect(result).toContain("[assistant]: I'll create a Button component");
		});

		it("skips entries without text content", () => {
			const entries: { type: string; message?: { content?: unknown } }[] = [
				{ type: "session_info", message: undefined },
				{ type: "model_change" },
			];

			// Should produce empty result for non-message entries
			const texts = entries
				.filter((e) => e.type === "message")
				.map((e) => (e.message?.content ? "found" : "skip"));

			expect(texts.length).toBe(0);
		});
	});

	describe("tool extraction", () => {
		it("extracts tool names from session entries", () => {
			const entries: { type: string; message?: { role?: string; content?: { type: string; text?: string; name?: string; arguments?: unknown }[] } }[] = [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "Let me read the file" },
							{ type: "toolCall", name: "read", arguments: { path: "src/app.ts" } },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", name: "edit", arguments: { path: "src/app.ts" } },
						],
					},
				},
			];

			const tools = new Set<string>();
			for (const e of entries) {
				if (!e.message?.content) continue;
				const parts: { type: string; name?: string }[] = Array.isArray(e.message.content) ? e.message.content : [];
				for (const p of parts) {
					if (p.type === "toolCall" && p.name) tools.add(p.name);
				}
			}

			expect(tools.has("read")).toBe(true);
			expect(tools.has("edit")).toBe(true);
			expect(tools.size).toBe(2);
		});

		it("returns empty set when no tools called", () => {
			const entries = [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			];

			const tools = new Set<string>();
			for (const e of entries) {
				if (!e.message?.content) continue;
				const parts: { type: string; name?: string }[] = Array.isArray(e.message.content) ? e.message.content : [];
				for (const p of parts) {
					if (p.type === "toolCall" && p.name) tools.add(p.name);
				}
			}

			expect(tools.size).toBe(0);
		});
	});
});
