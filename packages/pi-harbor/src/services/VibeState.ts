import { Context, Effect, Layer } from "effect";

const DIRECTOR_TOOLS = new Set([
   "vibe",
   "read",
   "describe_image",
   "web_search_exa",
   "deep_search_exa",
   "web_fetch_exa",
   "read_session",
   "workflow",
   "mcp"
]);

export function isDirectorTool(name: string): boolean {
   if (DIRECTOR_TOOLS.has(name)) return true;
   if (name === "mcp" || name.startsWith("mcp_")) return true;
   return false;
}

export function restoreVibeState(entries: ReadonlyArray<any>, registeredToolNames: ReadonlyArray<string>): string[] {
   const vibeEntries = entries.filter((e) => e && e.customType === "vibe-state");
   const lastEntry = vibeEntries.length > 0 ? vibeEntries[vibeEntries.length - 1] : undefined;

   let savedList: string[];
   if (lastEntry && Array.isArray(lastEntry.data?.savedTools)) {
      savedList = lastEntry.data.savedTools;
   } else {
      savedList = registeredToolNames.filter((name) => name !== "vibe" && !name.startsWith("vibe_"));
   }

   return savedList.filter((name) => registeredToolNames.includes(name));
}

export interface VibeStateShape {
   readonly isVibeActive: Effect.Effect<boolean>;
   readonly setVibeActive: (active: boolean) => Effect.Effect<void>;
   readonly terminateVibeSessions: Effect.Effect<void>;
   readonly checkToolAllowed: (toolName: string) => Effect.Effect<{ allowed: boolean; reason?: string }>;
}

export class VibeState extends Context.Service<VibeState, VibeStateShape>()("harbor/VibeState") {
   static readonly layer = Layer.effect(
      VibeState,
      Effect.sync(() => {
         let active = false;

         const isVibeActive = Effect.sync(() => active);

         const setVibeActive = (vibeOn: boolean) =>
            Effect.sync(() => {
               active = vibeOn;
            });

         const terminateVibeSessions = Effect.sync(() => {
            // Stub/API hook for terminating vibe worker sessions on vibe OFF
         });

         const checkToolAllowed = (toolName: string) =>
            Effect.sync(() => {
               if (active && !isDirectorTool(toolName)) {
                  return {
                     allowed: false,
                     reason: `Tool '${toolName}' is disabled in Vibe Director mode.`
                  };
               }
               return { allowed: true };
            });

         return VibeState.of({
            isVibeActive,
            setVibeActive,
            terminateVibeSessions,
            checkToolAllowed
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: VibeStateShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | VibeState> {
      return Effect.gen(function* () {
         const svc = yield* VibeState;
         return yield* fn(svc);
      });
   }
}
