import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MAX_EXECUTOR_MEMORY_LIMIT_BYTES, normalizeRaftConfig } from "../src/config.js";
import { buildRaftSettingsItems } from "../src/ui/settings-sections.js";
import { SectionSubmenu, SelectSubmenu, StringInputSubmenu } from "../src/ui/settings-submenus.js";
import {
  buildPartial,
  coerceValue,
  EXECUTOR_KERNELS,
  PYTHON_RUNTIMES,
  summaryFor,
} from "../src/ui/settings-values.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const settings = (input: Record<string, unknown> = {}) => {
  const config = normalizeRaftConfig("execution" in input ? input : { execution: input });
  const applied: Array<{ id: string; value: unknown }> = [];
  const items = buildRaftSettingsItems(theme, config, (id, value) => applied.push({ id, value }), {
    modelSource: { models: [], lastUsed: {} },
  });
  const executor = items.find((item) => item.id === "execution.executor")!;
  const section = executor.submenu!(executor.currentValue, () => {}) as SectionSubmenu;
  const row = (id: string) => section.items.find((item) => item.id === id)!;
  return { config, applied, items, executor, section, row };
};

describe("kernel settings", () => {
  it("registers exclusive kernel and CPython string controls beside a TS-only runtime", () => {
    const { section, row } = settings();
    expect(EXECUTOR_KERNELS).toEqual(["typescript", "python"]);
    expect(row("execution.executor.kernel")).toMatchObject({
      currentValue: "typescript",
      values: EXECUTOR_KERNELS,
    });
    expect(row("execution.executor.kernel").description).toContain("no per-call switching");
    expect(row("execution.executor.cpython.binary").currentValue).toBe("python3");
    expect(row("execution.executor.cpython.binary").submenu).toBeDefined();
    expect(row("execution.executor.runtime").label).toBe("Runtime (TS)");
    expect(row("execution.executor.runtime").description).toContain("ignored by Python");
    expect(section.items.some((item) => item.id === "execution.executor.cpython.enabled")).toBe(
      false,
    );
    const rendered = section.render(80);
    expect(rendered.join("\n")).toContain("CPython binary");
    expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("passes kernel selection through generic string coercion and persistence", () => {
    const { section, applied, config } = settings();
    section.applyChange("execution.executor.kernel", "python");
    expect(applied).toEqual([{ id: "execution.executor.kernel", value: "python" }]);
    expect(
      buildPartial(
        "execution.executor.kernel",
        coerceValue("execution.executor.kernel", "python", config),
      ),
    ).toEqual({ execution: { executor: { kernel: "python" } } });
  });

  it("submits a CPython executable path with the reusable string input", () => {
    const { row, section, applied, config } = settings({ executor: { kernel: "python" } });
    const binary = row("execution.executor.cpython.binary");
    const input = binary.submenu!(binary.currentValue, (value) => {
      if (value !== undefined) section.applyChange(binary.id, value);
    }) as StringInputSubmenu;
    expect(input).toBeInstanceOf(StringInputSubmenu);
    expect(input.input.getValue()).toBe("python3");
    input.submitRpc("  /opt/Python 3/bin/python3  ");
    expect(applied).toEqual([
      { id: "execution.executor.cpython.binary", value: "/opt/Python 3/bin/python3" },
    ]);
    expect(
      buildPartial(binary.id, coerceValue(binary.id, "/opt/Python 3/bin/python3", config)),
    ).toEqual({ execution: { executor: { cpython: { binary: "/opt/Python 3/bin/python3" } } } });
  });

  it("keeps a cancelled binary input from persisting", () => {
    const { row, section, applied } = settings();
    const binary = row("execution.executor.cpython.binary");
    const input = binary.submenu!(binary.currentValue, (value) => {
      if (value !== undefined) section.applyChange(binary.id, value);
    }) as StringInputSubmenu;
    input.handleInput("\u001b");
    expect(applied).toEqual([]);
  });

  it("defaults Python to Monty and persists explicit native opt-in", () => {
    const { row, executor, config, section, applied } = settings({
      executor: { kernel: "python" },
    });
    expect(PYTHON_RUNTIMES).toEqual(["monty", "cpython"]);
    expect(row("execution.executor.pythonRuntime")).toMatchObject({
      currentValue: "monty",
      values: PYTHON_RUNTIMES,
    });
    expect(row("execution.executor.pythonRuntime").description).toContain(
      "explicit trusted-native escape hatch",
    );
    expect(row("execution.executor.memoryLimitBytes").description).toContain(
      "Monty VM allocation limit",
    );
    expect(executor.currentValue).toContain("python · monty");
    section.applyChange("execution.executor.pythonRuntime", "cpython");
    expect(applied).toEqual([{ id: "execution.executor.pythonRuntime", value: "cpython" }]);
    expect(
      buildPartial(
        "execution.executor.pythonRuntime",
        coerceValue("execution.executor.pythonRuntime", "cpython", config),
      ),
    ).toEqual({ execution: { executor: { pythonRuntime: "cpython" } } });
  });

  it("explains Python address-space limits and offers the native ceiling", () => {
    const { row } = settings({
      executor: { kernel: "python", pythonRuntime: "cpython", runtime: "quickjs" },
    });
    const memory = row("execution.executor.memoryLimitBytes");
    expect(memory.description).toContain("RLIMIT_AS");
    expect(memory.description).toContain("where the OS supports it");
    expect(memory.description).toContain("not a security sandbox");
    expect(memory.description).not.toContain("WASM32");
    const submenu = memory.submenu!(memory.currentValue, () => {}) as SelectSubmenu;
    expect(submenu.options.map((option) => option.value)).toContain(
      String(MAX_EXECUTOR_MEMORY_LIMIT_BYTES),
    );
  });

  it("summarizes the active kernel/backend while preserving deadline details", () => {
    const { config, executor } = settings({
      executor: {
        kernel: "python",
        pythonRuntime: "cpython",
        runtime: "bun-process",
        cpython: { binary: "python3.12" },
        hostCallTimeouts: { "extensions.subagent": 300_000 },
      },
    });
    expect(executor.currentValue).toBe("python · python3.12 · 2m · max 15m · 1 ref floor");
    expect(executor.currentValue).not.toContain("bun-process");
    config.execution.executor.kernel = "typescript";
    expect(summaryFor("execution.executor", config)).toBe(
      "typescript · bun-process · 2m · max 15m · 1 ref floor",
    );
  });
});
