import { describe, expect, it } from "vitest";
import {
   computeTasksDashboardBodyHeight,
   createTasksDashboardState,
   reduceTasksDashboardKey,
   requestControl,
   type DashboardContext,
   type TasksDashboardState
} from "../src/ui/tasks-dashboard.js";

describe("Tasks Dashboard Pure State Machine", () => {
   it("creates default state", () => {
      const state = createTasksDashboardState();
      expect(state.activeTab).toBe("jobs");
      expect(state.selectedIndex).toBe(0);
      expect(state.isOpen).toBe(true);
      expect(state.takeoverJobId).toBeUndefined();
      expect(state.logProcessName).toBeUndefined();
   });

   it("cycles tabs with Tab and Shift+Tab", () => {
      let state = createTasksDashboardState();
      
      // Tab forward
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("bash");
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("processes");
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("logs");
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("takeover");
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("jobs");

      // Shift+Tab backward
      ({ state } = reduceTasksDashboardKey(state, { key: "tab", shift: true }));
      expect(state.activeTab).toBe("takeover");
   });

   it("navigates selection with j/k and down/up", () => {
      let state = createTasksDashboardState();
      const ctx: DashboardContext = { itemCount: 5 };

      ({ state } = reduceTasksDashboardKey(state, { key: "down" }, ctx));
      expect(state.selectedIndex).toBe(1);

      ({ state } = reduceTasksDashboardKey(state, { key: "j" }, ctx));
      expect(state.selectedIndex).toBe(2);

      ({ state } = reduceTasksDashboardKey(state, { key: "up" }, ctx));
      expect(state.selectedIndex).toBe(1);

      ({ state } = reduceTasksDashboardKey(state, { key: "k" }, ctx));
      expect(state.selectedIndex).toBe(0);

      // Clamp at top
      ({ state } = reduceTasksDashboardKey(state, { key: "up" }, ctx));
      expect(state.selectedIndex).toBe(0);

      // Clamp at bottom
      state.selectedIndex = 4;
      ({ state } = reduceTasksDashboardKey(state, { key: "down" }, ctx));
      expect(state.selectedIndex).toBe(4);
   });

   it("Enter on jobs tab opens takeover tab for selected job", () => {
      const state = createTasksDashboardState({ activeTab: "jobs", selectedIndex: 1 });
      const ctx: DashboardContext = { jobs: [{ id: "task-1" }, { id: "task-2" }] };

      const result = reduceTasksDashboardKey(state, { key: "enter" }, ctx);
      expect(result.state.activeTab).toBe("takeover");
      expect(result.state.takeoverJobId).toBe("task-2");
   });

   it("Enter on processes tab opens logs tab for selected process", () => {
      const state = createTasksDashboardState({ activeTab: "processes", selectedIndex: 0 });
      const ctx: DashboardContext = { processes: [{ name: "api-server" }] };

      const result = reduceTasksDashboardKey(state, { key: "enter" }, ctx);
      expect(result.state.activeTab).toBe("logs");
      expect(result.state.logProcessName).toBe("api-server");
   });

   it("Alt+Enter on jobs tab emits followUp control intent for selected job", () => {
      const state = createTasksDashboardState({ activeTab: "jobs", selectedIndex: 0 });
      const ctx: DashboardContext = {
         jobs: [{ id: "task-1" }],
         inputText: "check status"
      };

      const result = reduceTasksDashboardKey(state, { key: "enter", alt: true }, ctx);
      expect(result.intent).toEqual({
         type: "takeover_control",
         id: "task-1",
         text: "check status",
         mode: "followUp"
      });
   });

   it("Enter on takeover tab emits steer control intent for takeoverJobId", () => {
      const state = createTasksDashboardState({
         activeTab: "takeover",
         takeoverJobId: "task-1",
         takeoverInput: "steer target"
      });

      const result = reduceTasksDashboardKey(state, { key: "enter" });
      expect(result.intent).toEqual({
         type: "takeover_control",
         id: "task-1",
         text: "steer target",
         mode: "steer"
      });
   });

   it("requestControl helper returns structured control request", () => {
      const req = requestControl("task-5", "cancel step", "steer");
      expect(req).toEqual({ id: "task-5", text: "cancel step", mode: "steer" });
   });

   it("'c' cancels job on jobs tab and stops process on processes tab", () => {
      // Jobs tab cancel
      let state = createTasksDashboardState({ activeTab: "jobs", selectedIndex: 0 });
      let ctx: DashboardContext = { jobs: [{ id: "task-10" }] };
      let res = reduceTasksDashboardKey(state, { key: "c" }, ctx);
      expect(res.intent).toEqual({ type: "cancel_job", id: "task-10" });

      // Processes tab stop
      state = createTasksDashboardState({ activeTab: "processes", selectedIndex: 0 });
      ctx = { processes: [{ name: "worker-1" }] };
      res = reduceTasksDashboardKey(state, { key: "c" }, ctx);
      expect(res.intent).toEqual({ type: "stop_process", name: "worker-1" });
   });

   it("'r' restarts process on processes tab", () => {
      const state = createTasksDashboardState({ activeTab: "processes", selectedIndex: 0 });
      const ctx: DashboardContext = { processes: [{ name: "worker-1" }] };
      const res = reduceTasksDashboardKey(state, { key: "r" }, ctx);
      expect(res.intent).toEqual({ type: "restart_process", name: "worker-1" });
   });

   it("Esc or q closes the dashboard", () => {
      const state = createTasksDashboardState();
      const resEsc = reduceTasksDashboardKey(state, { key: "escape" });
      expect(resEsc.state.isOpen).toBe(false);
      expect(resEsc.intent).toEqual({ type: "close" });

      const resQ = reduceTasksDashboardKey(state, { key: "q" });
      expect(resQ.state.isOpen).toBe(false);
      expect(resQ.intent).toEqual({ type: "close" });
   });
});

import { visibleWidth } from "@earendil-works/pi-tui";
import { enterAlternateScreen } from "../src/ui/alternate-screen.js";
import {
   applyTranscriptUpdate,
   buildJobHeaderLines,
   buildJobTranscriptLines,
   computeTakeoverViewportHeight,
   createTakeoverScrollState,
   moveTakeoverScroll
} from "../src/ui/takeover.js";

describe("Takeover Overlay Helper", () => {
   it("preserves the absolute transcript position while new output arrives", () => {
      const state = moveTakeoverScroll(
         applyTranscriptUpdate(createTakeoverScrollState(), 0, 40, 10),
         "up",
         40,
         10
      );
      expect(state.followTail).toBe(false);
      expect(state.scrollTop).toBe(26);

      const updated = applyTranscriptUpdate(state, 40, 45, 10);
      expect(updated.scrollTop).toBe(26);
      expect(updated.unseenLines).toBe(5);

      const latest = moveTakeoverScroll(updated, "latest", 45, 10);
      expect(latest.followTail).toBe(true);
      expect(latest.scrollTop).toBe(35);
      expect(latest.unseenLines).toBe(0);
   });

   it("keeps auto-follow at the tail when the user has not scrolled up", () => {
      const state = applyTranscriptUpdate(createTakeoverScrollState(), 10, 25, 10);
      expect(state.followTail).toBe(true);
      expect(state.scrollTop).toBe(15);
      expect(state.unseenLines).toBe(0);
   });

   it("fits the transcript viewport below wrapped header, input, and footer lines", () => {
      expect(computeTakeoverViewportHeight(24, 3, 2)).toBe(14);
      expect(computeTakeoverViewportHeight(8, 10, 3)).toBe(1);
   });

   it("keeps the dashboard body inside the terminal rows", () => {
      expect(computeTasksDashboardBodyHeight(24)).toBe(20);
      expect(computeTasksDashboardBodyHeight(4)).toBe(1);
   });

   it("enters and exits the terminal alternate screen with full redraws", () => {
      const writes: string[] = [];
      const renderCalls: boolean[] = [];
      const previousChildren = [{ id: "chat" }, { id: "editor" }];
      const screen = {
         id: "dashboard",
         render: () => [],
         invalidate: () => {}
      };
      const tui = {
         children: [...previousChildren],
         clear() {
            this.children = [];
         },
         addChild(child: unknown) {
            this.children.push(child);
         },
         terminal: { write: (value: string) => writes.push(value) },
         requestRender: (force?: boolean) => renderCalls.push(Boolean(force))
      } as any;
      const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      try {
         const release = enterAlternateScreen(tui, screen);
         expect(tui.children).toEqual([screen]);
         release();

         expect(tui.children).toEqual(previousChildren);
         expect(writes).toEqual(["\u001b[?1049h\u001b[2J\u001b[H", "\u001b[?1049l"]);
         expect(renderCalls).toEqual([true, true]);
      } finally {
         if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
         else delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
   });
   it("renders resolved agent, harness, model, thinking, and cwd on a second header row", () => {
      const dummyTheme = {
         fg: (_color: string, text: string) => text,
         bold: (text: string) => text
      } as any;
      const lines = buildJobHeaderLines(
         {
            id: "task-3",
            name: "investigate-copy-all",
            agent: "light-task",
            harness: "pi",
            model: "proxy/cfai/@cf/moonshotai/kimi-k2.7-code",
            thinking: "high",
            cwd: "C:/Users/niel/.pi/agent",
            promptOrCommand: "Investigate copy-all",
            status: "running",
            createdAt: 1000,
            startedAt: 1000
         } as any,
         120,
         dummyTheme,
         2000
      );

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("task-3 · investigate-copy-all · running");
      expect(lines[1]).toContain("agent light-task");
      expect(lines[1]).toContain("via pi");
      expect(lines[1]).toContain("model proxy/cfai/@cf/moonshotai/kimi-k2.7-code");
      expect(lines[1]).toContain("thinking high");
      expect(lines[1]).toContain("cwd C:/Users/niel/.pi/agent");
   });

   it("builds transcript lines for job with rawText and resultData", () => {
      const dummyTheme = {
         fg: (_color: string, text: string) => text,
         bold: (text: string) => text
      } as any;

      const job: any = {
         id: "task-1",
         promptOrCommand: "Run tests",
         rawText: "Step 1: starting\nStep 2: done",
         resultData: { success: true }
      };

      const lines = buildJobTranscriptLines(job, 80, dummyTheme);
      expect(lines.some((l) => l.includes("Run tests"))).toBe(true);
      expect(lines.some((l) => l.includes("Step 1: starting"))).toBe(true);
      expect(lines.some((l) => l.includes("success"))).toBe(true);
   });

   it("renders semantic tool calls and actual results instead of synthetic markers", () => {
    const dummyTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text
    } as any;
    const job: any = {
      id: "task-semantic",
      harness: "pi",
      promptOrCommand: "Inspect source",
      transcript: [
        { type: "thinking", text: "I should inspect the requested directory." },
        { type: "assistant", text: "I will inspect it." },
        { type: "user", text: "Check the nested file too" },
        {
          type: "tool-call",
          toolCallId: "call-find",
          toolName: "find",
          arguments: { path: "extensions/copy-all", pattern: "*" }
        },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read",
          arguments: { path: "src/main.ts" }
        },
        {
          type: "tool-result",
          toolCallId: "call-find",
          toolName: "find",
          content: [{ type: "text", text: "README.md\nindex.ts" }],
          isError: false
        },
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read",
          content: [
            { type: "text", text: "hidden read contents" },
            { type: "image", mimeType: "image/png" }
          ],
          isError: false
        },
        {
          type: "tool-call",
          toolCallId: "call-grep",
          toolName: "grep",
          arguments: { pattern: "TODO", path: "src" }
        },
        {
          type: "tool-call",
          toolCallId: "call-ls",
          toolName: "ls",
          arguments: { path: "src" }
        },
        {
          type: "tool-result",
          toolCallId: "call-grep",
          toolName: "grep",
          content: [{ type: "text", text: "src/a.ts:1:TODO\nsrc/b.ts:2:TODO" }],
          isError: false
        },
        {
          type: "tool-result",
          toolCallId: "call-ls",
          toolName: "ls",
          content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
          isError: false
        },
        {
          type: "tool-call",
          toolCallId: "call-hub",
          toolName: "hub",
          arguments: { op: "exec", command: "pnpm check" }
        },
        {
          type: "tool-result",
          toolCallId: "call-hub",
          toolName: "hub",
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, stdout: "checks passed", stderr: "", exitCode: 0 })
            }
          ],
          isError: false
        }
      ]
    };

    const lines = buildJobTranscriptLines(job, 80, dummyTheme);
    const rendered = lines.join("\n");
    expect(rendered).toContain("Thinking:");
    expect(rendered).toContain("requested");
    expect(rendered).toContain("You: Check the nested file too");
    expect(rendered).toContain("→ find extensions/copy-all · * (found 2 results)");
    expect(rendered).toContain("→ grep TODO · src (found 2 results)");
    expect(rendered).toContain("→ ls src (found 3 results)");
    expect(rendered).toContain("→ hub exec pnpm check");
    expect(rendered).toContain("✓ hub exit 0 · checks passed");
    expect(rendered).not.toContain('{"ok":true');
    expect(rendered).toContain("(found 2 results)");
    expect(rendered).not.toContain("README.md");
    expect(rendered).not.toContain("index.ts");
    expect(rendered).not.toContain("result · find");
    expect(rendered).toContain("→ read src/main.ts");
    expect(rendered).not.toContain("hidden read contents");
    expect(rendered).not.toContain("[image image/png]");
    expect(rendered.indexOf("→ find")).toBeLessThan(rendered.indexOf("(found 2 results)"));
    expect(rendered.indexOf("(found 2 results)")).toBeLessThan(rendered.indexOf("→ read"));
    expect(rendered).not.toContain('"type": "tool-call"');
    expect(rendered).not.toContain('"toolName": "read"');
    expect(rendered).not.toContain("[tool]");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);

    const collapsedThinking = buildJobTranscriptLines(job, 80, dummyTheme, { showThinking: false }).join("\n");
    expect(collapsedThinking).toContain("Thinking...");
    expect(collapsedThinking).not.toContain("I should inspect the requested directory.");
  });

  it("wraps all transcript content to the chat viewport width", () => {
      const dummyTheme = {
         fg: (_color: string, text: string) => text,
         bold: (text: string) => text
      } as any;
      const width = 24;
      const job: any = {
         id: "task-2",
         promptOrCommand: "Explain this deliberately long task prompt without clipping it",
         rawText: "A deliberately long assistant response line that must wrap inside chat\nhttps://example.com/this/is/a/very/long/unbroken/path",
         errorText: "A deliberately long error message that must also wrap"
      };

      const lines = buildJobTranscriptLines(job, width, dummyTheme);

      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).toContain("assistant response");
      expect(lines.join("\n")).toContain("very/long/unbroken");
   });
});

