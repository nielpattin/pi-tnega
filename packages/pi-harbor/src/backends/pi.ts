import { Context, Effect, Layer } from "effect";
import { ControlError, CancelError, type ControlMode, type BackendCapabilities } from "../domain.js";

export type { ControlMode };

export const PI_BACKEND_CAPABILITIES: BackendCapabilities = {
   steering: true,
   followUp: true,
   midTurnTools: true,
   modelSelection: true,
   reasoningEffort: true
};

export interface BackendSession {
   readonly capabilities: BackendCapabilities;
   readonly control: (text: string, mode: ControlMode) => Effect.Effect<void, ControlError>;
   readonly abort: () => Effect.Effect<void, CancelError>;
}

export interface SessionControlTarget {
   readonly isStreaming: boolean;
   readonly steer: (text: string) => Promise<void> | void;
   readonly followUp: (text: string) => Promise<void> | void;
   readonly prompt: (text: string) => Promise<void> | void;
}

export interface SessionCancelTarget {
   readonly clearQueue?: () => void;
   readonly abort: () => Promise<void> | void;
}

export const routeControl = Effect.fn("PiBackend.routeControl")(function* (
   session: SessionControlTarget,
   text: string,
   mode: ControlMode
) {
   return yield* Effect.tryPromise({
      try: async () => {
         if (session.isStreaming) {
            if (mode === "steer") {
               await session.steer(text);
            } else {
               await session.followUp(text);
            }
         } else {
            await session.prompt(text);
         }
      },
      catch: (err) =>
         new ControlError({
            message: err instanceof Error ? err.message : String(err)
         })
   });
});

export const cancelSession = Effect.fn("PiBackend.cancelSession")(function* (
   session: SessionCancelTarget,
   timeoutMs: number = 5000
) {
   return yield* Effect.tryPromise({
      try: async () => {
         if (typeof session.clearQueue === "function") {
            session.clearQueue();
         }
         const abortPromise = Promise.resolve(session.abort());
         let timerId: any;
         const timeoutPromise = new Promise((_, reject) => {
            timerId = setTimeout(() => reject(new Error("Abort timed out")), timeoutMs);
         });
         try {
            await Promise.race([abortPromise, timeoutPromise]);
         } finally {
            clearTimeout(timerId);
         }
      },
      catch: (err) =>
         new CancelError({
            message: err instanceof Error ? err.message : String(err)
         })
   });
});

export interface CreateChildInitOptionsParams {
   cwd: string;
   agentDir: string;
   settingsManager: unknown;
   agentDef: {
      body: string;
      tools: readonly string[];
   };
}

export function createChildInitOptions(params: CreateChildInitOptionsParams) {
   return {
      loaderOptions: {
         cwd: params.cwd,
         agentDir: params.agentDir,
         settingsManager: params.settingsManager,
         systemPrompt: params.agentDef.body
      },
      createSessionOptions: {}
   };
}

export function configureChildTools(
   childSession: {
      getAllTools: () => Array<{ name: string }>;
      setActiveToolsByName: (names: string[]) => void;
   },
   allowedTools: readonly string[]
) {
   const available = new Set(childSession.getAllTools().map((t) => t.name));
   const filtered = allowedTools.filter((t) => available.has(t));
   childSession.setActiveToolsByName(filtered);
}

export interface PiSessionRunnerOptions {
   session: {
      subscribe?: (fn: (event: any) => void) => () => void;
      prompt: (text: string) => Promise<void> | void;
      clearQueue?: () => void;
      abort: () => Promise<void> | void;
   };
   onSettle: (status: "completed" | "failed" | "cancelled", data?: unknown, errorText?: string) => void;
}

export class PiSessionRunner {
   private reminderCount = 0;
   private settled = false;

   constructor(private options: PiSessionRunnerOptions) {}

   public handleEvent(event: any): void {
      if (this.settled) return;

      if (event?.type === "tool_execution_end" && event?.toolName === "submit") {
         const result = event.args?.result ?? event.result;
         if (result && typeof result === "object") {
            if ("data" in result) {
               this.settle("completed", result.data);
               return;
            }
            if ("error" in result) {
               this.settle("failed", undefined, String(result.error));
               return;
            }
         }
         this.settle("completed", result);
         return;
      }

      if (event?.type === "agent_end") {
         if (this.reminderCount < 3) {
            this.reminderCount++;
            Promise.resolve(
               this.options.session.prompt("Please call the submit tool to submit your final result or error.")
            ).catch(() => {});
         } else {
            this.settle("failed", undefined, "Job ended with missing submit after 3 reminders");
         }
      }
   }

   private settle(status: "completed" | "failed" | "cancelled", data?: unknown, errorText?: string): void {
      if (this.settled) return;
      this.settled = true;
      this.options.onSettle(status, data, errorText);
   }
}

export interface PiBackendShape {
   readonly capabilities: BackendCapabilities;
}

export class PiBackend extends Context.Service<PiBackend, PiBackendShape>()("harbor/PiBackend") {
   static readonly layer = Layer.effect(
      PiBackend,
      Effect.sync(() =>
         PiBackend.of({
            capabilities: PI_BACKEND_CAPABILITIES
         })
      )
   );
}
