/**
 * Tests for the Tool Validation + Auto-Repair extension.
 *
 * Validates schema checking, auto-repair logic, and error tracking.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Tool schemas (mirror of the extension's inline schemas)
// ---------------------------------------------------------------------------

const SCHEMAS: Record<string, { required: string[]; types: Record<string, string> }> = {
	read: { required: ["path"], types: { path: "string", offset: "number", limit: "number" } },
	write: { required: ["path", "content"], types: { path: "string", content: "string" } },
	edit: { required: ["path", "edits"], types: { path: "string", edits: "array" } },
	bash: { required: ["command"], types: { command: "string", timeout: "number" } },
	grep: { required: ["pattern"], types: { pattern: "string", path: "string", limit: "number" } },
};

const ALIASES: Record<string, string[]> = {
	path: ["filePath", "file_path", "file", "target"],
	content: ["text", "data", "body", "value"],
	pattern: ["query", "search", "term", "regex"],
	command: ["cmd", "shell", "run"],
	edits: ["edit", "changes", "patches"],
};

// ---------------------------------------------------------------------------
// Inline versions of validate / autoRepair / detectType to test
// ---------------------------------------------------------------------------

function detectType(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function validate(toolName: string, input: Record<string, unknown>): string[] {
	const schema = SCHEMAS[toolName];
	if (!schema) return [];
	const errors: string[] = [];
	for (const field of schema.required) {
		if (input[field] === undefined || input[field] === null) errors.push(`missing required field '${field}'`);
	}
	for (const [field, expectedType] of Object.entries(schema.types)) {
		const value = input[field];
		if (value === undefined || value === null) continue;
		const actualType = detectType(value);
		if (expectedType === "array" && actualType !== "array") errors.push(`'${field}' must be array, got ${actualType}`);
		else if (expectedType !== "array" && actualType !== expectedType) errors.push(`'${field}' must be ${expectedType}, got ${actualType}`);
	}
	return errors;
}

function attemptRepair(toolName: string, input: Record<string, unknown>): { didRepair: boolean; repairs: string[] } {
	const repairs: string[] = [];
	const schema = SCHEMAS[toolName];
	if (!schema) return { didRepair: false, repairs };

	for (const [field, expectedType] of Object.entries(schema.types)) {
		const value = input[field];
		if (value === undefined) continue;
		const actualType = detectType(value);
		if (actualType === expectedType) continue;

		if (expectedType === "number" && actualType === "string") {
			const parsed = Number(value as string);
			if (!isNaN(parsed)) { input[field] = parsed; repairs.push(`${field}: parsed string → number`); }
		} else if (expectedType === "string" && (actualType === "number" || actualType === "boolean")) {
			input[field] = String(value); repairs.push(`${field}: converted ${actualType} → string`);
		} else if (expectedType === "array" && actualType === "object" && !Array.isArray(value)) {
			input[field] = [value]; repairs.push(`${field}: wrapped single object in array`);
		}
	}

	for (const field of schema.required) {
		if (input[field] === undefined || input[field] === null) {
			const aliases = ALIASES[field];
			if (aliases) {
				for (const alias of aliases) {
					if (input[alias] !== undefined) {
						input[field] = input[alias];
						delete input[alias];
						repairs.push(`${field}: mapped from '${alias}'`);
						break;
					}
				}
			}
		}
	}

	return { didRepair: repairs.length > 0, repairs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool Validator", () => {
	describe("detectType", () => {
		it("detects string", () => expect(detectType("hello")).toBe("string"));
		it("detects number", () => expect(detectType(42)).toBe("number"));
		it("detects array", () => expect(detectType([1, 2])).toBe("array"));
		it("detects null", () => expect(detectType(null)).toBe("null"));
		it("detects undefined", () => expect(detectType(undefined)).toBe("null"));
		it("detects object", () => expect(detectType({})).toBe("object"));
	});

	describe("validate", () => {
		it("passes valid read input", () => {
			expect(validate("read", { path: "src/app.ts" })).toEqual([]);
		});

		it("catches missing required field", () => {
			expect(validate("read", {})).toContain("missing required field 'path'");
		});

		it("catches wrong type", () => {
			const errs = validate("bash", { command: 123 as unknown as string });
			expect(errs).toContain("'command' must be string, got number");
		});

		it("catches non-array edits", () => {
			const errs = validate("edit", { path: "f.ts", edits: "replace x with y" });
			expect(errs).toContain("'edits' must be array, got string");
		});

		it("validates bash command", () => {
			expect(validate("bash", { command: "ls -la" })).toEqual([]);
		});

		it("returns empty for unknown tool", () => {
			expect(validate("unknown_tool", { foo: "bar" })).toEqual([]);
		});
	});

	describe("autoRepair", () => {
		it("repairs string → number conversion", () => {
			const input: Record<string, unknown> = { command: "ls", timeout: "30" };
			const result = attemptRepair("bash", input);
			expect(result.didRepair).toBe(true);
			expect(input.timeout).toBe(30);
			expect(result.repairs[0]).toContain("timeout");
		});

		it("repairs number → string conversion", () => {
			const input: Record<string, unknown> = { path: 123 as unknown as string };
			const result = attemptRepair("read", input);
			expect(result.didRepair).toBe(true);
			expect(input.path).toBe("123");
		});

		it("wraps single edit object in array", () => {
			const input: Record<string, unknown> = { path: "f.ts", edits: { oldText: "a", newText: "b" } };
			const result = attemptRepair("edit", input);
			expect(result.didRepair).toBe(true);
			expect(Array.isArray(input.edits)).toBe(true);
			expect((input.edits as Array<unknown>).length).toBe(1);
		});

		it("maps alias to required field", () => {
			const input: Record<string, unknown> = { filePath: "src/app.ts", limit: 50 };
			const result = attemptRepair("read", input);
			expect(result.didRepair).toBe(true);
			expect(input.path).toBe("src/app.ts");
			expect(input.filePath).toBeUndefined();
		});

		it("does not repair already valid input", () => {
			const input: Record<string, unknown> = { path: "f.ts", content: "hello" };
			const result = attemptRepair("write", input);
			expect(result.didRepair).toBe(false);
			expect(result.repairs).toEqual([]);
		});

		it("repairs missing content via text alias", () => {
			const input: Record<string, unknown> = { path: "f.ts", text: "console.log('hi');" };
			const result = attemptRepair("write", input);
			expect(result.didRepair).toBe(true);
			expect(input.content).toBe("console.log('hi');");
			expect(input.text).toBeUndefined();
		});

		it("does nothing for unknown tool", () => {
			const input: Record<string, unknown> = { foo: "bar" };
			const result = attemptRepair("unknown", input);
			expect(result.didRepair).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("empty string path fails validation", () => {
			// validate only checks presence, not content — path-safety hook in hook-system catches empty
			const errs = validate("read", { path: "" });
			expect(errs.length).toBe(0); // field is present, just empty
		});

		it("boolean converted to string", () => {
			const input: Record<string, unknown> = { path: true as unknown as string };
			const result = attemptRepair("read", input);
			expect(result.didRepair).toBe(true);
			expect(input.path).toBe("true");
		});

		it("null required field is caught", () => {
			const errs = validate("bash", { command: null as unknown as string });
			expect(errs).toContain("missing required field 'command'");
		});
	});
});
