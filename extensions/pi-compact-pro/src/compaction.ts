import { contentText, uuidv7, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, serializeConversation, type ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ModelOverride {
   /** Optional maximum context window for this provider/model pair. */
   maxContext?: number;
}

export interface CompactionConfig {
   /** Maximum context window in tokens. Models with larger windows are capped. */
   maxContext: number;
   /** Context token count at which auto-compaction triggers. This is global. */
   compactionTarget: number;
   /** Recent tokens to keep unsummarized during compaction. */
   keepRecentTokens: number;
   /** Whether auto-compaction is enabled. */
   enabled: boolean;
   /** Per-model maximum-context overrides. Compaction target remains global because native Pi settings are global. */
   modelOverrides?: Record<string, ModelOverride>;
   /** Optional ordered list of up to 3 models to use for summarization (fallback order). Format: "provider/modelId" */
   summaryModels?: string[];
}

export const DEFAULT_CONFIG: CompactionConfig = {
   maxContext: 128_000,
   compactionTarget: 64_000,
   keepRecentTokens: 20_000,
   enabled: true
};

/** Sentinel value meaning "no context cap" (use each model's native window). */
export const NO_CAP = -1;

export interface EffectiveCompactionConfig {
   maxContext: number;
   compactionTarget: number;
   keepRecentTokens: number;
   enabled: boolean;
}

function positiveInteger(value: unknown, fallback: number): number {
   return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeOverride(value: unknown): ModelOverride | undefined {
   if (!value || typeof value !== "object") return undefined;
   const raw = (value as Record<string, unknown>).maxContext;
   const maxContext = raw === NO_CAP ? NO_CAP : positiveInteger(raw, 0);
   return maxContext !== 0 ? { maxContext } : undefined;
}

/** Normalize persisted or user-provided values before they reach native settings. */
export function normalizeConfig(value: unknown): CompactionConfig {
   const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
   const noCap = input.maxContext === NO_CAP;
   const maxContext = noCap ? NO_CAP : positiveInteger(input.maxContext, DEFAULT_CONFIG.maxContext);
   const requestedTarget = positiveInteger(input.compactionTarget, DEFAULT_CONFIG.compactionTarget);
   const compactionTarget = noCap ? requestedTarget : Math.min(requestedTarget, Math.max(1, maxContext - 1));
   const keepRecentTokens = positiveInteger(input.keepRecentTokens, DEFAULT_CONFIG.keepRecentTokens);

   const modelOverrides: Record<string, ModelOverride> = {};
   if (input.modelOverrides && typeof input.modelOverrides === "object") {
      for (const [key, rawOverride] of Object.entries(input.modelOverrides as Record<string, unknown>)) {
         const override = normalizeOverride(rawOverride);
         if (override) modelOverrides[key] = override;
      }
   }

   const summaryModels: string[] = [];
   if (Array.isArray(input.summaryModels)) {
      for (const item of input.summaryModels) {
         if (typeof item === "string" && item.trim()) {
            summaryModels.push(item.trim());
         }
      }
   }
   const normalizedSummaryModels = summaryModels.slice(0, 3);

   return {
      maxContext,
      compactionTarget,
      keepRecentTokens,
      enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_CONFIG.enabled,
      ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
      ...(normalizedSummaryModels.length > 0 ? { summaryModels: normalizedSummaryModels } : {})
   };
}

export function modelKey(provider: string, modelId: string): string {
   return `${provider}/${modelId}`;
}

export interface ContextWindowModelLike {
   provider: string;
   id: string;
   contextWindow?: number;
}

export function getOriginalContextWindow(
   model: ContextWindowModelLike,
   originalContextWindows: OriginalContextWindows
): number {
   return originalContextWindows.get(modelKey(model.provider, model.id)) ?? model.contextWindow ?? 0;
}

export function getEffectiveContextWindow(
   model: ContextWindowModelLike,
   config: CompactionConfig,
   originalContextWindows: OriginalContextWindows
): number {
   const originalWindow = getOriginalContextWindow(model, originalContextWindows);
   return Math.min(originalWindow, getEffectiveConfig(config, model.provider, model.id).maxContext);
}

export function getReserveTokensForModel(
   model: ContextWindowModelLike,
   config: CompactionConfig,
   originalContextWindows: OriginalContextWindows
): number {
   const effectiveWindow = getEffectiveContextWindow(model, config, originalContextWindows);
   const target = Math.min(config.compactionTarget, Math.max(1, effectiveWindow - 1));
   return Math.max(1, effectiveWindow - target);
}

export function getEffectiveConfig(
   config: CompactionConfig,
   provider: string,
   modelId: string
): EffectiveCompactionConfig {
   const override = config.modelOverrides?.[modelKey(provider, modelId)];
   const overrideMax = override?.maxContext;
   const maxContext =
      overrideMax === undefined
         ? config.maxContext <= 0
            ? Number.POSITIVE_INFINITY
            : config.maxContext
         : overrideMax <= 0
           ? Number.POSITIVE_INFINITY
           : overrideMax;
   return {
      maxContext,
      compactionTarget: config.compactionTarget,
      keepRecentTokens: config.keepRecentTokens,
      enabled: config.enabled
   };
}

export interface RegistryModel {
   contextWindow: number;
   provider: string;
   id: string;
}

export interface ModelRegistryLike {
   find(provider: string, id: string): RegistryModel | undefined;
   getAll(): RegistryModel[];
}

export type OriginalContextWindows = Map<string, number>;

/**
 * Apply contextWindow cap to a single model object directly.
 * Preserves the original context window in memory for reversible updates.
 */
export function capModelDirectly(
   model: { provider: string; id: string; contextWindow?: number } | undefined,
   config: CompactionConfig,
   originalContextWindows: OriginalContextWindows
): number | undefined {
   if (!model || typeof model.contextWindow !== "number") return undefined;
   const key = modelKey(model.provider, model.id);
   const original = getOriginalContextWindow(model, originalContextWindows);
   originalContextWindows.set(key, original);
   model.contextWindow = getEffectiveContextWindow(model, config, originalContextWindows);
   return model.contextWindow;
}

/**
 * Apply a cap without losing the model's original context window. This makes
 * increasing or resetting the cap work without requiring a process restart.
 */
export function capModelContextWindow(
   registry: ModelRegistryLike,
   config: CompactionConfig,
   provider: string,
   modelId: string,
   originalContextWindows: OriginalContextWindows
): number | undefined {
   const model = registry.find(provider, modelId);
   if (!model) return undefined;
   return capModelDirectly(model, config, originalContextWindows);
}

export interface ScopedModelLike {
   model: RegistryModel;
}

export function capAllModels(
   registry: ModelRegistryLike,
   config: CompactionConfig,
   originalContextWindows: OriginalContextWindows,
   scopedModels?: readonly ScopedModelLike[]
): void {
   for (const model of registry.getAll()) {
      capModelDirectly(model, config, originalContextWindows);
   }
   if (scopedModels) {
      for (const scoped of scopedModels) {
         capModelDirectly(scoped.model, config, originalContextWindows);
      }
   }
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, adding new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing constraints and preferences, adding new ones]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Include previous and newly completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Current blockers, or "(none)"]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next action]

## Critical Context
- [Exact context needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, symbols, commands, URLs, identifiers, and error messages.`;

export const COMPACTION_INSTRUCTIONS = `Additional compaction focus:

1. Preserve every exact file path that was read, modified, or created. Keep file paths in Critical Context.
2. Preserve exact error messages, commands, URLs, identifiers, and the attempted fixes.
3. Record important decisions and the rationale behind them.
4. State the exact current task, last completed action, active work, and immediate next action.
5. Preserve relevant environment facts such as versions, available tools, directory layout, and API behavior.
6. Preserve user preferences, constraints, and working conventions.
7. Do not abbreviate paths or error messages.
8. Do not emit <read-files> or <modified-files> tags. Pi appends those tags automatically from tool activity after the model response.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the kept suffix]

Be concise. Focus on what's needed to understand the kept suffix.`;

export function buildSummaryPrompt({
   conversationText,
   previousSummary,
   customInstructions
}: {
   conversationText: string;
   previousSummary?: string;
   customInstructions?: string;
}): string {
   const previous = previousSummary ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>` : "";
   const custom = customInstructions?.trim() ? `\n\nUser-provided focus:\n${customInstructions.trim()}` : "";
   const instructions = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
   return `<conversation>\n${conversationText}\n</conversation>${previous}\n\n${instructions}\n\n${COMPACTION_INSTRUCTIONS}${custom}`;
}

function buildTurnPrefixPrompt(conversationText: string, customInstructions?: string): string {
   const custom = customInstructions?.trim() ? `\n\nUser-provided focus:\n${customInstructions.trim()}` : "";
   return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}\n\n${COMPACTION_INSTRUCTIONS}${custom}`;
}

export function formatFileOperations(readFiles: readonly string[], modifiedFiles: readonly string[]): string {
   const read = [...new Set(readFiles)].toSorted();
   const modified = [...new Set(modifiedFiles)].toSorted();
   const sections: string[] = [];
   if (read.length > 0) sections.push(`<read-files>\n${read.join("\n")}\n</read-files>`);
   if (modified.length > 0) sections.push(`<modified-files>\n${modified.join("\n")}\n</modified-files>`);
   return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

function getFileOperationDetails(fileOps: CompactionPreparationLike["fileOps"]): {
   readFiles: string[];
   modifiedFiles: string[];
} {
   const modified = new Set([...fileOps.written, ...fileOps.edited]);
   const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).toSorted();
   const modifiedFiles = [...modified].toSorted();
   return { readFiles, modifiedFiles };
}

function combineUsage(first: Usage, second: Usage): Usage {
   return {
      input: first.input + second.input,
      output: first.output + second.output,
      cacheRead: first.cacheRead + second.cacheRead,
      cacheWrite: first.cacheWrite + second.cacheWrite,
      ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
         ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
         : {}),
      ...(first.reasoning !== undefined || second.reasoning !== undefined
         ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
         : {}),
      totalTokens: first.totalTokens + second.totalTokens,
      cost: {
         input: first.cost.input + second.cost.input,
         output: first.cost.output + second.cost.output,
         cacheRead: first.cost.cacheRead + second.cost.cacheRead,
         cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
         total: first.cost.total + second.cost.total
      }
   };
}

export interface CompactionPreparationLike {
   firstKeptEntryId: string;
   messagesToSummarize: AgentMessage[];
   turnPrefixMessages: AgentMessage[];
   isSplitTurn: boolean;
   tokensBefore: number;
   previousSummary?: string;
   fileOps: {
      read: ReadonlySet<string>;
      written: ReadonlySet<string>;
      edited: ReadonlySet<string>;
   };
   settings: {
      reserveTokens: number;
      keepRecentTokens: number;
      enabled: boolean;
   };
}

export interface CustomCompactionResult {
   summary: string;
   firstKeptEntryId: string;
   tokensBefore: number;
   usage?: Usage;
   details: {
      readFiles: string[];
      modifiedFiles: string[];
   };
}

async function completeSummary(
   registry: Pick<ModelRegistry, "complete">,
   model: Model<any>,
   prompt: string,
   maxTokens: number,
   signal: AbortSignal
): Promise<{ text: string; usage: Usage } | undefined> {
   if (signal.aborted) return undefined;
   try {
      const response = await registry.complete(
         model,
         {
            systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
            messages: [
               {
                  role: "user",
                  content: [{ type: "text", text: prompt }],
                  timestamp: Date.now()
               }
            ]
         } satisfies Context,
         {
            maxTokens,
            signal,
            cacheRetention: "none",
            sessionId: uuidv7()
         }
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
      const text = contentText(response.content).trim();
      if (!text) return undefined;
      return { text, usage: response.usage };
   } catch {
      return undefined;
   }
}

async function summarizeMessages(
   messages: AgentMessage[],
   previousSummary: string | undefined,
   registry: Pick<ModelRegistry, "complete">,
   model: Model<any>,
   reserveTokens: number,
   signal: AbortSignal,
   customInstructions?: string
): Promise<{ text: string; usage: Usage } | undefined> {
   const conversationText = serializeConversation(convertToLlm(messages));
   return completeSummary(
      registry,
      model,
      buildSummaryPrompt({ conversationText, previousSummary, customInstructions }),
      Math.max(
         1,
         Math.min(Math.floor(reserveTokens * 0.8), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY)
      ),
      signal
   );
}

async function summarizeTurnPrefix(
   messages: AgentMessage[],
   registry: Pick<ModelRegistry, "complete">,
   model: Model<any>,
   reserveTokens: number,
   signal: AbortSignal,
   customInstructions?: string
): Promise<{ text: string; usage: Usage } | undefined> {
   const conversationText = serializeConversation(convertToLlm(messages));
   return completeSummary(
      registry,
      model,
      buildTurnPrefixPrompt(conversationText, customInstructions),
      Math.max(
         1,
         Math.min(Math.floor(reserveTokens * 0.5), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY)
      ),
      signal
   );
}

export function resolveCandidateModels(
   summaryModels: readonly string[] | undefined,
   registry: Pick<ModelRegistry, "complete"> & Partial<Pick<ModelRegistry, "find" | "getAll">>,
   sessionModel: Model<any>
): Model<any>[] {
   const candidates: Model<any>[] = [];
   const seen = new Set<string>();

   if (summaryModels && summaryModels.length > 0) {
      for (const spec of summaryModels.slice(0, 3)) {
         let resolved: Model<any> | undefined;
         const slashIndex = spec.indexOf("/");
         if (slashIndex > 0) {
            const provider = spec.slice(0, slashIndex);
            const id = spec.slice(slashIndex + 1);
            if (typeof registry.find === "function") {
               resolved = registry.find(provider, id) as Model<any> | undefined;
            }
         } else if (typeof registry.getAll === "function") {
            resolved = (registry.getAll() as Model<any>[]).find((m) => m.id === spec);
         }

         if (resolved) {
            const key = modelKey(resolved.provider, resolved.id);
            if (!seen.has(key)) {
               seen.add(key);
               candidates.push(resolved);
            }
         }
      }
   }

   const sessionKey = modelKey(sessionModel.provider, sessionModel.id);
   if (!seen.has(sessionKey)) {
      candidates.push(sessionModel);
   }

   return candidates.length > 0 ? candidates : [sessionModel];
}

/** Generate a native-compatible custom result, falling back through up to 3 summary models + session model. */
export async function generateCustomCompaction({
   preparation,
   registry,
   model,
   signal,
   customInstructions,
   summaryModels
}: {
   preparation: CompactionPreparationLike;
   registry: Pick<ModelRegistry, "complete"> & Partial<Pick<ModelRegistry, "find" | "getAll">>;
   model: Model<any>;
   signal: AbortSignal;
   customInstructions?: string;
   summaryModels?: readonly string[];
}): Promise<CustomCompactionResult | undefined> {
   const candidateModels = resolveCandidateModels(summaryModels, registry, model);

   /* eslint-disable no-await-in-loop */
   for (const candidate of candidateModels) {
      if (signal.aborted) return undefined;

      let summary: string | undefined;
      let usage: Usage | undefined;

      if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
         const history =
            preparation.messagesToSummarize.length > 0
               ? await summarizeMessages(
                    preparation.messagesToSummarize,
                    preparation.previousSummary,
                    registry,
                    candidate,
                    preparation.settings.reserveTokens,
                    signal,
                    customInstructions
                 )
               : undefined;
         const prefix = await summarizeTurnPrefix(
            preparation.turnPrefixMessages,
            registry,
            candidate,
            preparation.settings.reserveTokens,
            signal,
            customInstructions
         );
         if (prefix) {
            summary = `${history?.text ?? "No prior history."}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
            usage = history ? combineUsage(history.usage, prefix.usage) : prefix.usage;
         }
      } else {
         const result = await summarizeMessages(
            preparation.messagesToSummarize,
            preparation.previousSummary,
            registry,
            candidate,
            preparation.settings.reserveTokens,
            signal,
            customInstructions
         );
         if (result) {
            summary = result.text;
            usage = result.usage;
         }
      }

      if (summary) {
         const details = getFileOperationDetails(preparation.fileOps);
         summary += formatFileOperations(details.readFiles, details.modifiedFiles);
         return {
            summary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            usage,
            details
         };
      }
   }
   /* eslint-enable no-await-in-loop */

   return undefined;
}
