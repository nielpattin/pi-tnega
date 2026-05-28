import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateSummary } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "pi-handoff";
const TOKEN_THRESHOLD = 200_000;
const RESERVE_TOKENS = 16_000;
const HANDOFF_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function shouldShowHandoffWidget(
   usage: { tokens: number | null } | undefined,
   threshold = TOKEN_THRESHOLD
): boolean {
   return typeof usage?.tokens === "number" && usage.tokens >= threshold;
}

export function buildHandoffInstructions(cwd: string, sessionFile: string | undefined): string {
   return `Create a session handoff for a fresh coding agent.

Do not write a transcript summary. Create a structured continuation briefing that lets a new agent resume without re-deriving context.

Current working directory: ${cwd}
Current Pi session file: ${sessionFile ?? "unknown"}

Include these sections:
- Mission and current scope
- Exact resume point
- Current repo and session state
- Important files, preferably absolute paths
- Commands run and what each proved
- Decisions made and rationale
- Constraints, user preferences, repo rules
- Verification status: passed, failed, not run
- Open questions, risks, blockers
- Immediate next steps, ordered and concrete

Rules:
- Prefer concise bullets over prose.
- Keep only high-signal facts.
- Include exact commands, paths, URLs, and error strings when important.
- Preserve rationale and dead ends that prevent repeated work.
- Do not invent facts.
- Make the first next step immediately executable.`;
}

export function buildNewSessionPrompt(handoff: string): string {
   return `Read this handoff completely, verify current repo state, then continue from the first concrete next step.\n\n<handoff>\n${handoff}\n</handoff>`;
}

function getBranchMessages(ctx: ExtensionCommandContext): AgentMessage[] {
   return ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
}

function updateWidget(ctx: ExtensionContext): void {
   if (shouldShowHandoffWidget(ctx.getContextUsage())) {
      ctx.ui.setWidget(WIDGET_KEY, ["Context high. Run /handoff"], { placement: "aboveEditor" });
      return;
   }

   ctx.ui.setWidget(WIDGET_KEY, undefined);
}

async function createHandoff(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
   const model = ctx.model;
   if (!model) {
      ctx.ui.notify("No active model for handoff.", "error");
      return;
   }

   const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
   if (!auth.ok) {
      ctx.ui.notify(auth.error, "error");
      return;
   }

   const messages = getBranchMessages(ctx);
   if (messages.length === 0) {
      ctx.ui.notify("No session messages to hand off.", "warning");
      return;
   }
   ctx.ui.setWorkingIndicator({ frames: HANDOFF_SPINNER_FRAMES });
   ctx.ui.setWorkingMessage("Creating handoff...");
   ctx.ui.setWorkingVisible(true);

   const controller = new AbortController();
   const signal = controller.signal;

   if (ctx.signal) {
      ctx.signal.addEventListener("abort", () => controller.abort());
   }

   let unsubscribe: (() => void) | undefined;
   if (ctx.hasUI) {
      unsubscribe = ctx.ui.onTerminalInput((data) => {
         if (data === "\x1b") {
            controller.abort();
            return { consume: true };
         }
      });
   }

   let spinnerIndex = 0;
   const interval = setInterval(() => {
      const frame = HANDOFF_SPINNER_FRAMES[spinnerIndex];
      ctx.ui.setWidget(WIDGET_KEY, [`Creating handoff... ${frame}`], { placement: "aboveEditor" });
      spinnerIndex = (spinnerIndex + 1) % HANDOFF_SPINNER_FRAMES.length;
   }, 80);

   let handoff: string;
   try {
      handoff = await generateSummary(
         messages,
         model,
         RESERVE_TOKENS,
         auth.apiKey ?? "",
         auth.headers,
         signal,
         buildHandoffInstructions(ctx.cwd, ctx.sessionManager.getSessionFile()),
         undefined,
         pi.getThinkingLevel()
      );
   } catch (error) {
      if (signal.aborted) {
         ctx.ui.notify("Handoff generation cancelled.", "info");
         return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Handoff failed: ${message}`, "error");
      return;
   } finally {
      unsubscribe?.();
      clearInterval(interval);
      updateWidget(ctx);
      ctx.ui.setWorkingIndicator();
      ctx.ui.setWorkingMessage();
      ctx.ui.setWorkingVisible(false);
   }
   if (signal.aborted) {
      ctx.ui.notify("Handoff generation cancelled.", "info");
      return;
   }

   try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      const edited = await ctx.ui.editor("Handoff", handoff);
      if (edited === undefined) {
         ctx.ui.notify("Handoff cancelled.", "info");
         updateWidget(ctx);
         return;
      }
      const finalHandoff = edited.trim();
      const parentSession = ctx.sessionManager.getSessionFile();

      await ctx.newSession({
         parentSession,
         setup: async (sessionManager) => {
            sessionManager.appendMessage({
               role: "user",
               content: buildNewSessionPrompt(finalHandoff),
               timestamp: Date.now()
            });
         }
      });
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Handoff failed: ${message}`, "error");
   }
}

export default function (pi: ExtensionAPI) {
   pi.on("session_start", async (_event, ctx) => {
      updateWidget(ctx);
   });

   pi.on("turn_end", async (_event, ctx) => {
      updateWidget(ctx);
   });

   pi.registerCommand("handoff", {
      description: "Generate an out-of-band handoff for a fresh session",
      handler: async (_args, ctx) => {
         await createHandoff(ctx, pi);
      }
   });
}
