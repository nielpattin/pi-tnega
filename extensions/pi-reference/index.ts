import type { ReferenceInfo } from "./types.js";
import { resolveReferences } from "./resolve.js";
import { setUiContext, setCurrentReferences, reportError } from "./status.js";
import { ReferenceAutocompleteProvider } from "./autocomplete.js";
import { buildReferenceGuidance } from "./system-prompt.js";

// ─── Module-level state ───────────────────────────────────────────

let resolvedReferences: ReferenceInfo[] = [];
let autocompleteRegistered = false;

// ─── Extension factory ────────────────────────────────────────────

export default function (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI): void {
   // Re-resolve references on every session start/reload/resume.
   // Git repos are cloned/fetched asynchronously (fire-and-forget).
   pi.on("session_start", async (_event, ctx) => {
      // Register @alias autocomplete provider (once, requires ctx.ui)
      if (!autocompleteRegistered && ctx.ui?.addAutocompleteProvider) {
         ctx.ui.addAutocompleteProvider((current) => {
            return new ReferenceAutocompleteProvider(current, () => resolvedReferences);
         });
         autocompleteRegistered = true;
      }
      setUiContext(
         ctx.ui
            ? {
                 hasUI: ctx.hasUI,
                 notify: ctx.ui.notify.bind(ctx.ui),
                 setStatus: ctx.ui.setStatus.bind(ctx.ui)
              }
            : null
      );
      try {
         resolvedReferences = await resolveReferences(ctx.cwd);
         setCurrentReferences(resolvedReferences);
      } catch (err) {
         reportError(`Failed to resolve references: ${err instanceof Error ? err.message : String(err)}`);
         resolvedReferences = [];
         setCurrentReferences(resolvedReferences);
      }
   });

   // Inject reference guidance into system prompt.
   pi.on("before_agent_start", (_event, _ctx) => {
      // Append reference guidance to system prompt
      const guidance = buildReferenceGuidance(resolvedReferences);
      if (!guidance) return {};
      return { systemPrompt: _event.systemPrompt + "\n\n" + guidance };
   });
}
