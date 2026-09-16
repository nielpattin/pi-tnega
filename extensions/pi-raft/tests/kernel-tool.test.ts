import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { normalizeRaftConfig } from "../src/config.js";
import type { RaftState } from "../src/raft-state.js";
import { createRaftExecTool } from "../src/raft-exec-tool.js";
import { prepareRaftExecArguments } from "../src/raft-exec-arguments.js";
import {
  defaultRaftExecutionGuidance,
  raftExecutionKernelGuidance,
} from "../src/core/system-guidance.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";

const toolFor = (
  kernel: "typescript" | "python",
  pythonRuntime: "cpython" | "monty" = "cpython",
) => {
  const state = {
    bootstrapped: true,
    config: normalizeRaftConfig({
      execution: { executor: { kernel, pythonRuntime } },
      appearance: { ui: { toolDisplay: "full" } },
    }),
  } as RaftState;
  return createRaftExecTool(state, defaultCodePreviewSettings(), (tool) => tool);
};

describe("exclusive kernel tool surface", () => {
  it("publishes only the configured language with no per-call selector", () => {
    const ts = toolFor("typescript");
    const python = toolFor("python");
    expect(ts.description).toContain("type-checked TypeScript");
    expect(ts.parameters.properties.code.description).toContain("TypeScript function body");
    expect(python.description).toContain("CPython");
    expect(python.description).not.toContain("TypeScript");
    expect(python.parameters.properties.code.description).toContain("Python async function body");
    expect(python.parameters.properties.code.description).not.toContain("TypeScript");
    expect(python.promptGuidelines?.join("\n")).toContain("asyncio.gather");
    expect(python.promptGuidelines?.join("\n")).not.toContain("Promise.all");
    expect(ts.parameters.properties).not.toHaveProperty("kernel");
    expect(python.parameters.properties).not.toHaveProperty("kernel");
    expect(python.parameters.properties).not.toHaveProperty("tokenBudget");
    expect(ts.parameters.properties).toHaveProperty("tokenBudget");
    expect(python.parameters.required).toEqual(["code"]);
  });

  it("describes Monty's subset without advertising native Python", () => {
    const tool = toolFor("python", "monty");
    expect(tool.description).toContain("Monty");
    expect(tool.parameters.properties.code.description).toContain("sandboxed Python subset");
    expect(tool.parameters.properties.code.description).not.toContain(
      "standard-library imports are available",
    );
    expect(defaultRaftExecutionGuidance("python", "monty")).toContain(
      "arbitrary imports are unavailable",
    );
    expect(raftExecutionKernelGuidance("python", "monty")).toContain("Monty sandboxed subset");
  });

  it("keeps Python source untouched while applying language-neutral argument normalization", () => {
    const code = "return await mcp.server.tool(/tmp/unquoted)";
    const input = { code: [code], strings: '{"body":"π😀\\ntext"}', display: "Probe" };
    expect(prepareRaftExecArguments(input)).toEqual({
      code,
      payloads: { body: "π😀\ntext" },
      display: { name: "Probe" },
    });
    expect(toolFor("python").prepareArguments!(code)).toEqual({ code });
    expect(prepareRaftExecArguments(code)).toEqual({ code });
  });

  it("renders a Python label rather than parsing Python as TypeScript", () => {
    const tool = toolFor("python");
    const args = { code: "import json\nreturn json.loads(π.body)" };
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const rendered = tool.renderCall!(args, theme, {
      args,
      state: {},
      invalidate: vi.fn(),
      toolCallId: "python",
      cwd: process.cwd(),
      executionStarted: false,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
    } as never)
      .render(120)
      .join("\n");
    expect(rendered).toContain("Python · 2 lines");
    expect(rendered).not.toContain("TypeScript");
  });

  it("registers safely before configuration is bootstrapped", () => {
    const state = {
      bootstrapped: false,
      get config(): never {
        throw new Error("not bootstrapped");
      },
    } as unknown as RaftState;
    const tool = createRaftExecTool(state, defaultCodePreviewSettings(), (value) => value);
    expect(tool.description).toContain("TypeScript");
    expect(tool.prepareArguments!("return 1")).toEqual({ code: "return 1" });
  });

  it.each(["typescript", "python"] as const)(
    "retains historical %s labels after a language switch",
    (kernel) => {
      const currentKernel = kernel === "python" ? "typescript" : "python";
      const tool = toolFor(currentKernel);
      const args = { code: "return 1" };
      const context = {
        args,
        state: {},
        invalidate: vi.fn(),
        toolCallId: "history",
        cwd: process.cwd(),
        executionStarted: false,
        argsComplete: true,
        isPartial: false,
        expanded: true,
        showImages: false,
        isError: false,
      };
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme;
      tool.renderResult!(
        { content: [], details: { kernel, success: true, audits: [], phases: [] } } as never,
        { expanded: false, isPartial: false },
        theme,
        context as never,
      );
      const rendered = tool.renderCall!(args, theme, context as never)
        .render(120)
        .join("\n");
      expect(rendered).toContain(kernel === "python" ? "Python · 1 line" : "TypeScript · 1 line");
      expect(context.invalidate).toHaveBeenCalledOnce();
    },
  );

  it("uses Python syntax in turn-stable guidance", () => {
    const guidance = defaultRaftExecutionGuidance("python");
    expect(guidance).toContain("Python backend: Monty sandboxed subset");
    expect(guidance).toContain("asyncio.gather");
    expect(guidance).not.toContain("Promise.all");
    expect(raftExecutionKernelGuidance("python")).toContain("Python (Monty sandboxed subset)");
    expect(raftExecutionKernelGuidance("python", "cpython")).toContain("Python (CPython)");
    expect(raftExecutionKernelGuidance("typescript")).toContain("kernel: TypeScript");
    expect(raftExecutionKernelGuidance("typescript")).toContain("orchestration-only mode");
  });
});
