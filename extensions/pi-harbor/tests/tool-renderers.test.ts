import { describe, expect, it, vi } from "vitest";
import {
   renderHubCall,
   renderHubResult,
   renderTaskCall,
   renderTaskResult,
   renderVibeCall,
   renderVibeResult
} from "../src/ui/tool-renderers.js";

const theme = {
   bold: (text: string) => text,
   fg: (_color: string, text: string) => text
} as never;

const textResult = (details: unknown, text = "") => ({
   content: [{ type: "text" as const, text }],
   details
});

function rendered(component: { render(width: number): string[] }): string {
   return component
      .render(120)
      .map((line) => line.trimEnd())
      .join("\n");
}

interface TestRenderState {
   spinnerIndex?: number;
   spinnerTimer?: ReturnType<typeof setTimeout>;
   spinnerRunning?: boolean;
   jobStatuses?: ReadonlyArray<string | undefined>;
}

interface TestRenderContext {
   state: TestRenderState;
   invalidate: () => void;
   isError?: boolean;
}

describe("Harbor tool renderers", () => {
   it("renders one task as a named one-job call with a loading indicator and prompt", () => {
      const output = rendered(
         renderTaskCall({ task: "Investigate the copy-all extension", name: "copy-all", agent: "scout" }, theme)
      );

      expect(output).toBe("task copy-all · scout  1 job ⠋\nInvestigate the copy-all extension");
      expect(output).not.toContain("worker");

   });

   it("animates the task loading indicator with Braille frames", () => {
      vi.useFakeTimers();
      const state: Record<string, unknown> = {};
      const invalidate = vi.fn();
      const context = { state, invalidate } as never;
      const args = { task: "Inspect schema", name: "schema", agent: "scout" };

      expect(rendered(renderTaskCall(args, theme, context))).toContain("⠋");
      vi.advanceTimersByTime(80);
      expect(invalidate).toHaveBeenCalledOnce();
      expect(rendered(renderTaskCall(args, theme, context))).toContain("⠙");
      vi.useRealTimers();
   });

   it("renders a single background task without trailing indicator, spinner, or timer", () => {
      vi.useFakeTimers();
      const state: Record<string, unknown> = {};
      const invalidate = vi.fn();
      const context = { state, invalidate } as never;
      const args = { task: "Investigate copy-all", name: "copy-all", agent: "scout", background: true };

      const call = rendered(renderTaskCall(args, theme, context));
      expect(call).toBe("task copy-all · scout  1 job\nInvestigate copy-all");
      expect(call).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      vi.advanceTimersByTime(200);
      expect(invalidate).not.toHaveBeenCalled();
      vi.useRealTimers();
   });

   it("mixes async and sync indicators in a batch", () => {
      const output = rendered(
         renderTaskCall(
            {
               tasks: [
                  { task: "Inspect schema", name: "schema", agent: "scout" },
                  { task: "Background work", name: "background", agent: "scout", background: true }
               ]
            },
            theme
         )
      );
      const lines = output.split("\n");
      expect(lines[1]).toContain("⠋");
      expect(lines[2]).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      expect(lines[2]).toContain("·");
   });

   it("stops the Braille spinner immediately when a single foreground task settles", async () => {
      vi.useFakeTimers();
      const state: Record<string, unknown> = {};
      const invalidate = vi.fn();
      const context = { state, invalidate, isError: false } as unknown as TestRenderContext;
      const args = { task: "Investigate copy-all", name: "copy-all", agent: "scout" };
      const result = textResult(
         {
            ok: true,
            id: "task-1",
            name: "copy-all",
            agent: "scout",
            status: "completed",
            result: { summary: "Done." }
         },
         '{"ok":true,"status":"completed","result":{"summary":"Done."}}'
      );

      const runningCall = rendered(renderTaskCall(args, theme, context));
      expect(runningCall).toContain("⠋");
      expect(context.state.spinnerTimer).toBeDefined();

      vi.advanceTimersByTime(160);
      rendered(renderTaskCall(args, theme, context));
      vi.advanceTimersByTime(160);
      rendered(renderTaskCall(args, theme, context));

      invalidate.mockClear();
      const resultComponent = renderTaskResult(result, { expanded: false, isPartial: false }, theme, context);
      const renderedResult = rendered(resultComponent);
      const settledCall = rendered(renderTaskCall(args, theme, context));

      expect(settledCall).toContain("✓");
      expect(settledCall).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      expect(renderedResult).toContain("Done.");
      expect(renderedResult).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

      const timerIdBefore = context.state.spinnerTimer;
      expect(timerIdBefore).toBeUndefined();
      expect(context.state.spinnerRunning).toBe(false);

      vi.advanceTimersByTime(200);
      expect(invalidate).not.toHaveBeenCalled();
      expect(context.state.spinnerTimer).toBeUndefined();

      vi.useRealTimers();
   });

   it("stops the Braille spinner when a single foreground task fails without an explicit status", async () => {
      vi.useFakeTimers();
      const state: Record<string, unknown> = {};
      const invalidate = vi.fn();
      const context = { state, invalidate, isError: true } as unknown as TestRenderContext;
      const args = { task: "Investigate copy-all", name: "copy-all", agent: "scout" };
      const result = textResult({ ok: false, error: "Something went wrong" });

      rendered(renderTaskCall(args, theme, context));
      vi.advanceTimersByTime(80);
      rendered(renderTaskCall(args, theme, context));
      expect(context.state.spinnerRunning).toBe(true);
      invalidate.mockClear();

      const renderedResult = rendered(
         renderTaskResult(result, { expanded: false, isPartial: false }, theme, context)
      );
      const settledCall = rendered(renderTaskCall(args, theme, context));

      expect(renderedResult).toContain("Something went wrong");
      expect(settledCall).toContain("✗");
      expect(settledCall).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      expect(context.state.spinnerRunning).toBe(false);
      expect(context.state.spinnerTimer).toBeUndefined();

      vi.advanceTimersByTime(200);
      expect(invalidate).not.toHaveBeenCalled();
      expect(context.state.spinnerTimer).toBeUndefined();

      vi.useRealTimers();
   });

   it("stops the Braille spinner on a completed partial update for a single foreground task", async () => {
      vi.useFakeTimers();
      const state: Record<string, unknown> = {};
      const invalidate = vi.fn();
      const context = { state, invalidate, isError: false } as unknown as TestRenderContext;
      const args = { task: "Investigate copy-all", name: "copy-all", agent: "scout" };
      const partialResult = textResult({
         ok: true,
         id: "task-1",
         name: "copy-all",
         agent: "scout",
         status: "completed"
      });
      const finalResult = textResult(
         {
            ok: true,
            id: "task-1",
            name: "copy-all",
            agent: "scout",
            status: "completed",
            result: { summary: "Done." }
         },
         '{"ok":true,"status":"completed","result":{"summary":"Done."}}'
      );

      rendered(renderTaskCall(args, theme, context));
      vi.advanceTimersByTime(80);
      rendered(renderTaskCall(args, theme, context));
      invalidate.mockClear();

      const partialOutput = rendered(
         renderTaskResult(partialResult, { expanded: false, isPartial: true }, theme, context)
      );
      expect(partialOutput).toBe("");
      expect(context.state.spinnerRunning).toBe(false);

      await Promise.resolve();
      const callAfterPartial = rendered(renderTaskCall(args, theme, context));
      expect(callAfterPartial).toContain("✓");
      expect(callAfterPartial).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

      invalidate.mockClear();
      const finalOutput = rendered(
         renderTaskResult(finalResult, { expanded: false, isPartial: false }, theme, context)
      );
      expect(finalOutput).toContain("Done.");
      expect(finalOutput).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

      vi.advanceTimersByTime(200);
      expect(invalidate).not.toHaveBeenCalled();
      expect(context.state.spinnerTimer).toBeUndefined();
      expect(context.state.spinnerRunning).toBe(false);

      vi.useRealTimers();
   });

   it("renders a batch as loading task rows with inline prompt previews", () => {
      const output = rendered(
         renderTaskCall(
            {
               tasks: [
                  { task: "Inspect schema", name: "schema", agent: "scout" },
                  { task: "Inspect rendering", name: "rendering", agent: "reviewer" },
                  { task: "Run all verification checks", name: "checks", agent: "task" }
               ]
            },
            theme
         )
      );

      expect(output).toBe(
         [
            "task 3 jobs",
            "⠋ schema · scout Inspect schema",
            "⠋ rendering · reviewer Inspect rendering",
            "⠋ checks · task Run all verification checks"
         ].join("\n")
      );
   });

   it("renders a two-task batch as `2 jobs`", () => {
      const output = rendered(
         renderTaskCall(
            {
               tasks: [
                  { task: "First job", name: "first", agent: "scout" },
                  { task: "Second job", name: "second", agent: "reviewer" }
               ]
            },
            theme
         )
      );

      expect(output).toContain("task 2 jobs");
   });

   it("renders larger batches with the `jobs` plural", () => {
      const tasks = Array.from({ length: 5 }, (_, i) => ({
         task: `Job ${i + 1}`,
         name: `job-${i + 1}`,
         agent: "task"
      }));
      const output = rendered(renderTaskCall({ tasks }, theme));

      expect(output).toContain("task 5 jobs");
   });

   it("moves settled indicators without invalidating re-entrantly and duplicating output", async () => {
      const state: Record<string, unknown> = {};
      const invalidate = vi.fn();
      const context = { state, invalidate, isError: false } as never;
      const args = {
         tasks: [
            { task: "Inspect schema", name: "schema", agent: "scout" },
            { task: "Inspect rendering", name: "rendering", agent: "reviewer" }
         ]
      };

      const result = rendered(
         renderTaskResult(
            textResult({
               ok: true,
               jobs: [
                  { id: "task-1", name: "schema", agent: "scout", status: "completed", result: null },
                  { id: "task-2", name: "rendering", agent: "reviewer", status: "failed", errorText: null }
               ]
            }),
            { expanded: false, isPartial: false },
            theme,
            context
         )
      );
      const call = rendered(renderTaskCall(args, theme, context));
      renderTaskResult(
         textResult({
            ok: true,
            jobs: [
               { id: "task-1", name: "schema", agent: "scout", status: "completed", result: null },
               { id: "task-2", name: "rendering", agent: "reviewer", status: "failed", errorText: null }
            ]
         }),
         { expanded: false, isPartial: false },
         theme,
         context
      );

      expect(call).toContain("✓ schema");
      expect(call).toContain("✗ rendering");
      expect(result).toBe("");
      expect(invalidate).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(invalidate).toHaveBeenCalledOnce();
   });

   it("keeps the task output slot hidden while work is partial", () => {
      const output = rendered(
         renderTaskResult(textResult({}), { expanded: false, isPartial: true }, theme, { isError: false })
      );

      expect(output).toBe("");
   });

   it("shows completed task output only after settlement and honors collapse and expand", () => {
      const running = rendered(
         renderTaskResult(
            textResult({
               ok: true,
               jobs: [{ id: "task-1", name: "copy-all", agent: "scout", status: "running", result: null }]
            }),
            { expanded: false, isPartial: false },
            theme,
            { isError: false }
         )
      );
      const result = textResult({
         ok: true,
         jobs: [
            {
               id: "task-1",
               name: "copy-all",
               agent: "scout",
               status: "completed",
               result: {
                  summary: "The extension copies the current response.",
                  files: ["extensions/copy-all/index.ts"]
               }
            }
         ]
      });
      const collapsed = rendered(
         renderTaskResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
      );
      const expanded = rendered(
         renderTaskResult(result, { expanded: true, isPartial: false }, theme, { isError: false })
      );

      expect(running).not.toContain("---");
      expect(collapsed).toContain("---\nThe extension copies the current response.");
      expect(collapsed).not.toContain("extensions/copy-all/index.ts");
      expect(expanded).toContain('"files"');
      expect(expanded).toContain("extensions/copy-all/index.ts");
   });

   it("renders hub operations and structured results", () => {
      expect(rendered(renderHubCall({ op: "logs", name: "api", lines: 50 }, theme))).toContain("hub logs api");
      expect(rendered(renderHubCall({ op: "exec", command: "pnpm check" }, theme))).toContain("pnpm check");

      const output = rendered(
         renderHubResult(
            textResult({ ok: true, processes: [{ name: "api", status: "running", pid: 42 }] }),
            { expanded: true, isPartial: false },
            theme,
            { isError: false }
         )
      );
      expect(output).toContain("1 process");
      expect(output).toContain("api");
      expect(output).toContain("running");
      expect(output).not.toContain('"processes"');
   });

   it("renders completed hub job output with collapsed and expanded detail", () => {
      const result = textResult({
         ok: true,
         jobs: [
            {
               id: "task-1",
               status: "completed",
               resultData: {
                  summary: "Implemented the requested Harbor behavior",
                  files: ["src/a.ts", "src/b.ts"]
               }
            }
         ]
      });
      const collapsed = rendered(
         renderHubResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
      );
      const expanded = rendered(
         renderHubResult(result, { expanded: true, isPartial: false }, theme, { isError: false })
      );

      expect(collapsed).toContain("task-1");
      expect(collapsed).toContain("Implemented the requested Harbor behavior");
      expect(collapsed).not.toContain("src/a.ts");
      expect(expanded).toContain("Implemented the requested Harbor behavior");
      expect(expanded).toContain("src/a.ts");
      expect(expanded).not.toContain('"resultData"');
   });

   it("renders unified vibe operations and results", () => {
      expect(rendered(renderVibeCall({ op: "spawn", cli: "fast", prompt: "Research this", name: "probe" }, theme))).toContain(
         "vibe spawn fast"
      );
      expect(rendered(renderVibeCall({ op: "send", session: "task-7", message: "Continue" }, theme))).toContain(
         "task-7"
      );

      const spawned = rendered(
         renderVibeResult(
            textResult({ ok: true, id: "task-7", title: "probe", harness: "pi", status: "running" }),
            { expanded: false, isPartial: false },
            theme,
            { isError: false }
         )
      );
      expect(spawned).toContain("task-7");
      expect(spawned).toContain("running");
   });

   it("renders partial and failed results semantically", () => {
      expect(
         rendered(
            renderHubResult(textResult({}), { expanded: false, isPartial: true }, theme, { isError: false })
         )
      ).toContain("working");
      expect(
         rendered(
            renderVibeResult(
               textResult({ ok: false, error: "session not found" }),
               { expanded: false, isPartial: false },
               theme,
               { isError: true }
            )
         )
      ).toContain("session not found");
   });
});
