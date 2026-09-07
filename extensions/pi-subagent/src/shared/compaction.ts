/** Minimal settings capability used to configure child compaction. */
export interface CompactionSettings {
   /** Read global settings. */
   readonly getGlobalSettings: () => unknown;
   /** Read project settings. */
   readonly getProjectSettings: () => unknown;
   /** Apply local settings overrides. */
   readonly applyOverrides: (value: { readonly compaction: { readonly enabled: boolean } }) => void;
}

function isExplicitlyDisabled(scope: unknown): boolean {
   if (!scope || typeof scope !== "object") return false;
   const compaction = (scope as { compaction?: unknown }).compaction;
   return Boolean(
      compaction && typeof compaction === "object" && (compaction as { enabled?: unknown }).enabled === false
   );
}

/**
 * Enable automatic compaction unless a global or project setting explicitly disables it.
 *
 * @param settings - Settings manager capability for the child session.
 */
export function ensureAutoCompactionEnabled(settings: CompactionSettings): void {
   if (isExplicitlyDisabled(settings.getGlobalSettings()) || isExplicitlyDisabled(settings.getProjectSettings()))
      return;
   settings.applyOverrides({ compaction: { enabled: true } });
}

/** Runtime state needed to distinguish terminal agent turns from compaction retries. */
export interface CompactionState {
   /** Whether Pi is currently compacting the child session. */
   readonly compacting: boolean;
   /** Whether Pi is retrying the provider request after an intermediate turn. */
   readonly retrying: boolean;
}

/** Event projection used by the compaction state machine. */
export interface CompactionEvent {
   readonly type?: string;
   readonly success?: boolean;
   readonly willRetry?: boolean;
}

/**
 * Create an idle compaction state.
 *
 * @returns A state with no active compaction or retry.
 */
export function createCompactionState(): CompactionState {
   return { compacting: false, retrying: false };
}

/**
 * Apply a Pi lifecycle event to the compaction state.
 *
 * @param state - The current child-session compaction state.
 * @param event - A Pi lifecycle event projection.
 * @returns The next immutable compaction state.
 */
export function observeCompactionEvent(state: CompactionState, event: CompactionEvent): CompactionState {
   switch (event.type) {
      case "compaction_start":
         return { ...state, compacting: true };
      case "compaction_end":
         return { ...state, compacting: false };
      case "auto_retry_start":
         return { ...state, retrying: true };
      case "auto_retry_end":
         return { ...state, retrying: false };
      default:
         return state;
   }
}

/**
 * Decide whether an agent-end event is an intermediate event that must not
 * settle the child agent yet.
 *
 * @param state - The current compaction state.
 * @param event - The agent-end event projection.
 * @returns `true` when completion must be deferred.
 */
export function shouldDeferAgentEnd(state: CompactionState, event: CompactionEvent): boolean {
   return state.compacting || state.retrying || event.willRetry === true;
}
