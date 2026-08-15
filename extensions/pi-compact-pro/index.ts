/**
 * Compaction Config Extension
 *
 * Makes auto-compaction configurable and improves compaction quality:
 *
 * 1. **Configurable max context** — caps the model's contextWindow (e.g. 128k
 *    for GLM 5.2, which pi defaults to 1M). This prevents the context from
 *    growing too large before compaction triggers.
 *
 * 2. **Configurable compaction target** — sets reserveTokens so that
 *    auto-compaction triggers at the target (e.g. 64k), not near the context
 *    window limit.
 *
 * 3. **Better compaction** — provides custom summarization instructions via
 *    session_before_compact to produce more useful, structured summaries that
 *    preserve critical context (file paths, error messages, decisions).
 *
 * 4. **`/compaction` command** — opens an interactive settings UI (like /settings)
 *    for viewing and changing compaction configuration. Also accepts text args
 *    for scripting: /compaction maxContext 128000
 *
 * Config file: ~/.pi/agent/.ext-config/pi-compact-pro.json
 * Persists to: ~/.pi/agent/settings.json (compaction section)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme, getSelectListTheme, DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
   capAllModels,
   capModelDirectly,
   capModelContextWindow,
   DEFAULT_CONFIG,
   generateCustomCompaction,
   getEffectiveContextWindow,
   getOriginalContextWindow,
   getReserveTokensForModel,
   NO_CAP,
   normalizeConfig,
   type CompactionConfig,
   type ModelOverride,
   type ModelRegistryLike,
   type OriginalContextWindows,
   type ScopedModelLike
} from "./src/compaction.ts";

export { DEFAULT_CONFIG, getEffectiveConfig, normalizeConfig, type CompactionConfig } from "./src/compaction.ts";
import { Container, Input, SelectList, SettingsList, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const HOME = () => process.env.HOME || process.env.USERPROFILE || "";
const AGENT_DIR = () => join(HOME(), ".pi", "agent");
const EXT_CONFIG_DIR = () => join(AGENT_DIR(), ".ext-config");
const CONFIG_PATH = () => join(EXT_CONFIG_DIR(), "pi-compact-pro.json");
const SETTINGS_PATH = () => join(AGENT_DIR(), "settings.json");
const LEGACY_CONFIG_PATHS = () => [
   join(EXT_CONFIG_DIR(), "compaction-config.json"),
   join(AGENT_DIR(), "extensions", "compaction-config.json")
];

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

export function readConfig(): CompactionConfig {
   try {
      const primary = CONFIG_PATH();
      if (existsSync(primary)) {
         const raw = readFileSync(primary, "utf8");
         return normalizeConfig(JSON.parse(raw));
      }
      for (const legacy of LEGACY_CONFIG_PATHS()) {
         if (existsSync(legacy)) {
            const raw = readFileSync(legacy, "utf8");
            const parsed = normalizeConfig(JSON.parse(raw));
            writeConfig(parsed);
            return parsed;
         }
      }
      return { ...DEFAULT_CONFIG };
   } catch {
      return { ...DEFAULT_CONFIG };
   }
}

export function writeConfig(config: CompactionConfig): void {
   try {
      const dir = EXT_CONFIG_DIR();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CONFIG_PATH(), JSON.stringify(normalizeConfig(config), null, 2) + "\n", "utf8");
   } catch {
      // ignore — non-fatal
   }
}

// ---------------------------------------------------------------------------
// Settings.json I/O (compaction section)
// ---------------------------------------------------------------------------

function readSettings(): Record<string, unknown> {
   try {
      if (!existsSync(SETTINGS_PATH())) return {};
      return JSON.parse(readFileSync(SETTINGS_PATH(), "utf8"));
   } catch {
      return {};
   }
}

function writeSettingsCompaction(reserveTokens: number, keepRecentTokens: number, enabled: boolean): boolean {
   try {
      const settings = readSettings();
      if (!settings.compaction || typeof settings.compaction !== "object") {
         settings.compaction = {};
      }
      const comp = settings.compaction as Record<string, unknown>;
      const changed =
         comp.reserveTokens !== reserveTokens || comp.keepRecentTokens !== keepRecentTokens || comp.enabled !== enabled;

      comp.reserveTokens = reserveTokens;
      comp.keepRecentTokens = keepRecentTokens;
      comp.enabled = enabled;

      if (changed) {
         writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2) + "\n", "utf8");
      }
      return changed;
   } catch {
      return false;
   }
}

/**
 * Persist native compaction settings for the active model.
 * Returns whether settings.json changed and the reserve that was written.
 */
function persistSettings(
   config: CompactionConfig,
   model: { provider: string; id: string; contextWindow: number } | undefined,
   originalContextWindows: OriginalContextWindows
): { settingsChanged: boolean; reserveTokens: number } {
   const reserveTokens = model
      ? getReserveTokensForModel(model, config, originalContextWindows)
      : Math.max(1, config.maxContext - config.compactionTarget);
   return {
      settingsChanged: writeSettingsCompaction(reserveTokens, config.keepRecentTokens, config.enabled),
      reserveTokens
   };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatTokens(n: number): string {
   if (n < 1000) return n.toString();
   if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
   if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
   return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
   let config = readConfig();
   const originalContextWindows: OriginalContextWindows = new Map();

   // Ensure config file exists with defaults on first load
   if (!existsSync(CONFIG_PATH())) {
      writeConfig(config);
   }

   const ensureCapsApplied = (ctx: {
      model?: { provider: string; id: string; contextWindow?: number };
      modelRegistry?: ModelRegistryLike;
      scopedModels?: readonly ScopedModelLike[];
   }) => {
      if (ctx.modelRegistry) {
         capAllModels(ctx.modelRegistry, config, originalContextWindows, ctx.scopedModels);
      }
      if (ctx.model) {
         capModelDirectly(ctx.model, config, originalContextWindows);
      }
   };

   // On session start: apply contextWindow cap + persist settings
   pi.on("session_start", async (_event, ctx) => {
      config = readConfig();
      ensureCapsApplied(ctx as unknown as Parameters<typeof ensureCapsApplied>[0]);

      // Persist compaction settings to settings.json.
      const { settingsChanged, reserveTokens } = persistSettings(config, ctx.model, originalContextWindows);

      if (settingsChanged) {
         ctx.ui.notify(
            `Compaction settings updated in settings.json. Run /reload to apply.\n` +
               `  reserveTokens: ${formatTokens(reserveTokens)}\n` +
               `  keepRecentTokens: ${formatTokens(config.keepRecentTokens)}\n` +
               `  enabled: ${config.enabled}`,
            "info"
         );
      }
   });

   // When user switches models: apply the cap and persist the matching native reserve.
   pi.on("model_select", async (event, ctx) => {
      capModelDirectly(event.model, config, originalContextWindows);
      ensureCapsApplied(ctx as unknown as Parameters<typeof ensureCapsApplied>[0]);
      const { settingsChanged, reserveTokens } = persistSettings(config, event.model, originalContextWindows);
      if (settingsChanged) {
         ctx.ui.notify(
            `Compaction reserve updated for ${event.model.provider}/${event.model.id}: ${formatTokens(reserveTokens)}. Run /reload to apply.`,
            "info"
         );
      }
   });

   // Guard caps on every turn to prevent uncapped models from being assigned through external commands
   pi.on("turn_start", (_event, ctx) => {
      ensureCapsApplied(ctx as unknown as Parameters<typeof ensureCapsApplied>[0]);
   });

   pi.on("before_agent_start", (_event, ctx) => {
      ensureCapsApplied(ctx as unknown as Parameters<typeof ensureCapsApplied>[0]);
   });

   // Returning `compaction` is the supported pre-compaction API. A bare
   // customInstructions property is not part of SessionBeforeCompactResult.
   pi.on("session_before_compact", async (event, ctx) => {
      if (!ctx.model) return undefined;
      const result = await generateCustomCompaction({
         preparation: event.preparation,
         registry: ctx.modelRegistry,
         model: ctx.model,
         signal: event.signal,
         customInstructions: event.customInstructions,
         summaryModels: config.summaryModels
      });
      return result ? { compaction: result } : undefined;
   });

   // /compaction command — view and change settings
   pi.registerCommand("compaction", {
      description: "View and configure auto-compaction settings (interactive UI)",
      handler: async (args, ctx) => {
         // Text-mode shortcut: /compaction <key> <value> or /compaction reset
         const parts = args.trim().split(/\s+/);
         const subcommand = parts[0]?.toLowerCase();

         if (subcommand === "reset") {
            config = normalizeConfig(DEFAULT_CONFIG);
            writeConfig(config);
            const { settingsChanged } = persistSettings(config, ctx.model, originalContextWindows);
            capAllModels(ctx.modelRegistry as unknown as ModelRegistryLike, config, originalContextWindows);
            const m = ctx.model;
            if (m)
               capModelContextWindow(
                  ctx.modelRegistry as unknown as ModelRegistryLike,
                  config,
                  m.provider,
                  m.id,
                  originalContextWindows
               );
            ctx.ui.notify(
               `Compaction settings reset to defaults.\n` +
                  (settingsChanged ? "Run /reload to apply settings.json changes." : ""),
               "info"
            );
            return;
         }

         if (subcommand && parts.length >= 2 && subcommand !== "") {
            const key = subcommand;
            const valueStr = parts[1];
            if (key === "enabled") {
               config.enabled = valueStr === "true" || valueStr === "1";
            } else if (key === "summarymodel" || key === "summarymodels" || key === "fallback" || key === "model") {
               if (valueStr === "default" || valueStr === "reset" || valueStr === "none" || valueStr === "auto") {
                  delete config.summaryModels;
               } else {
                  config.summaryModels = valueStr
                     .split(",")
                     .map((s) => s.trim())
                     .filter(Boolean)
                     .slice(0, 3);
               }
            } else if (key === "maxcontext" || key === "target" || key === "keeprecent") {
               const value = parseInt(valueStr, 10);
               if (isNaN(value) || value <= 0) {
                  ctx.ui.notify(`Invalid value for ${key}: ${valueStr}`, "error");
                  return;
               }
               if (key === "maxcontext") config.maxContext = value;
               else if (key === "target") config.compactionTarget = value;
               else if (key === "keeprecent") config.keepRecentTokens = value;
            } else {
               ctx.ui.notify(
                  `Unknown setting: ${key}\nValid: maxContext, target, keepRecent, enabled, summaryModel`,
                  "error"
               );
               return;
            }
            config = normalizeConfig(config);
            writeConfig(config);
            capAllModels(ctx.modelRegistry as unknown as ModelRegistryLike, config, originalContextWindows);
            const m = ctx.model;
            if (m)
               capModelContextWindow(
                  ctx.modelRegistry as unknown as ModelRegistryLike,
                  config,
                  m.provider,
                  m.id,
                  originalContextWindows
               );
            const { settingsChanged } = persistSettings(config, m, originalContextWindows);
            ctx.ui.notify(
               `Updated: ${key}=${valueStr}\n` +
                  (settingsChanged ? "Run /reload to apply settings.json changes." : "Applied immediately."),
               "info"
            );
            return;
         }

         // No args → interactive TUI settings panel
         if (ctx.mode !== "tui") {
            ctx.ui.notify("Interactive /compaction requires TUI mode. Use: /compaction <key> <value>", "error");
            return;
         }

         await ctx.ui.custom<void>((tui, theme, _kb, done) => {
            // Helper to apply config changes after a setting is changed
            const applyConfig = (newConfig: CompactionConfig) => {
               config = normalizeConfig(newConfig);
               writeConfig(config);
               capAllModels(ctx.modelRegistry as unknown as ModelRegistryLike, config, originalContextWindows);
               const m = ctx.model;
               if (m)
                  capModelContextWindow(
                     ctx.modelRegistry as unknown as ModelRegistryLike,
                     config,
                     m.provider,
                     m.id,
                     originalContextWindows
                  );
               persistSettings(config, m, originalContextWindows);
            };

            // --- Choice builders (evaluated lazily so submenus stay current) ---

            /** Prepend the current value when it is not already among the presets. */
            const withCurrent = (presets: Option[], current: string, label: string): Option[] =>
               presets.some((p) => p.value === current)
                  ? presets
                  : [
                       {
                          value: current,
                          label,
                          description: "Current value (custom)"
                       },
                       ...presets
                    ];

            const maxContextChoices = (): Option[] =>
               withCurrent(
                  [
                     {
                        value: "__nocap__",
                        label: "No cap (native windows)",
                        description: "Use each model's provider context size"
                     },
                     { value: "32000", label: "32k", description: "32,000 tokens" },
                     { value: "64000", label: "64k", description: "64,000 tokens" },
                     { value: "96000", label: "96k", description: "96,000 tokens" },
                     { value: "128000", label: "128k", description: "128,000 tokens" },
                     { value: "200000", label: "200k", description: "200,000 tokens" },
                     { value: "256000", label: "256k", description: "256,000 tokens" },
                     { value: "512000", label: "512k", description: "512,000 tokens" },
                     { value: "1000000", label: "1M", description: "1,000,000 tokens" },
                     { value: "__custom__", label: "Custom value…", description: "Type any token count" }
                  ],
                  config.maxContext === NO_CAP ? "__nocap__" : String(config.maxContext),
                  config.maxContext === NO_CAP ? "No cap (native windows)" : formatTokens(config.maxContext)
               );

            const targetChoices = (): Option[] =>
               withCurrent(
                  [
                     { value: "40000", label: "40k", description: "40,000 tokens" },
                     { value: "60000", label: "60k", description: "60,000 tokens" },
                     { value: "64000", label: "64k", description: "64,000 tokens" },
                     { value: "80000", label: "80k", description: "80,000 tokens" },
                     { value: "96000", label: "96k", description: "96,000 tokens" },
                     { value: "120000", label: "120k", description: "120,000 tokens" },
                     { value: "160000", label: "160k", description: "160,000 tokens" },
                     { value: "200000", label: "200k", description: "200,000 tokens" },
                     { value: "__custom__", label: "Custom value…", description: "Type any token count" }
                  ],
                  String(config.compactionTarget),
                  formatTokens(config.compactionTarget)
               );

            const keepRecentChoices = (): Option[] =>
               withCurrent(
                  [
                     { value: "5000", label: "5k", description: "5,000 tokens" },
                     { value: "10000", label: "10k", description: "10,000 tokens" },
                     { value: "15000", label: "15k", description: "15,000 tokens" },
                     { value: "20000", label: "20k", description: "20,000 tokens" },
                     { value: "30000", label: "30k", description: "30,000 tokens" },
                     { value: "40000", label: "40k", description: "40,000 tokens" },
                     { value: "60000", label: "60k", description: "60,000 tokens" },
                     { value: "__custom__", label: "Custom value…", description: "Type any token count" }
                  ],
                  String(config.keepRecentTokens),
                  formatTokens(config.keepRecentTokens)
               );

            // Available models (registry snapshot) used by the model pickers.
            const availableModels = ctx.modelRegistry.getAvailable
               ? ctx.modelRegistry.getAvailable()
               : ctx.modelRegistry.getAll();

            const modelWindowDescription = (m: {
               provider: string;
               id: string;
               name?: string;
               contextWindow: number;
            }): string => {
               const original = getOriginalContextWindow(m, originalContextWindows);
               const effective = getEffectiveContextWindow(m, config, originalContextWindows);
               const cap = effective < original ? ` · effective ${formatTokens(effective)}` : "";
               const name = m.name && m.name !== m.id ? `${m.name} · ` : "";
               return `${name}${formatTokens(original)} native window${cap}`;
            };

            /** "Active session model" + every registry model. */
            const getSummaryModelChoices = (): Option[] => {
               const choices: Option[] = [
                  {
                     value: "default",
                     label: "Active session model",
                     description: "Use the session's active model"
                  }
               ];
               for (const m of availableModels) {
                  const key = `${m.provider}/${m.id}`;
                  if (!choices.some((c) => c.value === key)) {
                     choices.push({ value: key, label: key, description: modelWindowDescription(m) });
                  }
               }
               return choices;
            };

            /** Fallback-slot picker: "None" + models (session model is the implicit final fallback). */
            const getFallbackChoices = (): Option[] => [
               {
                  value: "none",
                  label: "None (disabled)",
                  description: "Do not use a fallback in this slot"
               },
               ...getSummaryModelChoices().filter((c) => c.value !== "default")
            ];

            /** Models available for per-model overrides. */
            const getOverrideModelChoices = (): Option[] =>
               getSummaryModelChoices().filter((c) => c.value !== "default");

            // Ordered fallback chain: slot 0 is the primary, slots 1-2 are fallbacks.
            const chainSlots = (): string[] => {
               const slots = ["default", "none", "none"];
               (config.summaryModels ?? []).slice(0, 3).forEach((v, i) => {
                  slots[i] = v;
               });
               return slots;
            };

            const slotLabel = (v: string): string =>
               v === "default" ? "Active session model" : v === "none" ? "None" : v;

            const setSlot = (index: number, value: string) => {
               const slots = chainSlots();
               slots[index] = value;
               const filtered = slots.filter((v) => v !== "none" && v !== "default");
               const next = { ...config };
               if (filtered.length === 0) delete next.summaryModels;
               else next.summaryModels = filtered.slice(0, 3);
               applyConfig(next);
            };

            // Build the settings list items
            const buildItems = () => {
               const model = ctx.model;
               const effectiveWindow = model
                  ? getEffectiveContextWindow(model, config, originalContextWindows)
                  : config.maxContext === NO_CAP
                    ? Number.POSITIVE_INFINITY
                    : config.maxContext;
               const reserveTokens = model
                  ? getReserveTokensForModel(model, config, originalContextWindows)
                  : Math.max(
                       1,
                       (config.maxContext === NO_CAP ? 1_000_000 : config.maxContext) - config.compactionTarget
                    );
               const effectiveTarget = Math.max(1, effectiveWindow - reserveTokens);
               const effLabel = Number.isFinite(effectiveWindow) ? formatTokens(effectiveWindow) : "native";

               const slots = chainSlots();
               const chainDisplay = (() => {
                  const chain = slots.filter((v) => v !== "none").map(slotLabel);
                  if (slots[0] === "default") return chain.join(" → ");
                  chain.push("Active session model");
                  return chain.join(" → ");
               })();

               const overrideCount = Object.keys(config.modelOverrides ?? {}).length;
               const maxContextDisplay =
                  config.maxContext === NO_CAP ? "No cap (native windows)" : formatTokens(config.maxContext);

               return [
                  {
                     id: "enabled",
                     label: "Auto-compaction",
                     description: "Enable or disable automatic context compaction",
                     currentValue: config.enabled ? "on" : "off",
                     values: ["on", "off"]
                  },
                  {
                     id: "compactionTarget",
                     label: "Compaction target",
                     description: `Trigger compaction when context reaches ${formatTokens(config.compactionTarget)}. Effective threshold for the active model: ${formatTokens(effectiveTarget)} (window minus reserve).`,
                     currentValue: formatTokens(config.compactionTarget),
                     submenu: (_cv: string, submenuDone: (v?: string) => void) =>
                        new SelectSubmenu(
                           theme,
                           "Compaction Target",
                           "Token count at which auto-compaction triggers",
                           targetChoices(),
                           String(config.compactionTarget),
                           (value: string) => {
                              applyConfig({ ...config, compactionTarget: tokenValue(value) });
                              submenuDone(value);
                           },
                           () => submenuDone(),
                           { customLabel: "compaction target" }
                        )
                  },
                  {
                     id: "keepRecentTokens",
                     label: "Keep recent",
                     description: "Recent tokens preserved unsummarized during compaction.",
                     currentValue: formatTokens(config.keepRecentTokens),
                     submenu: (_cv: string, submenuDone: (v?: string) => void) =>
                        new SelectSubmenu(
                           theme,
                           "Keep Recent Tokens",
                           "Recent context to keep intact during compaction",
                           keepRecentChoices(),
                           String(config.keepRecentTokens),
                           (value: string) => {
                              applyConfig({ ...config, keepRecentTokens: tokenValue(value) });
                              submenuDone(value);
                           },
                           () => submenuDone(),
                           { customLabel: "keep-recent value" }
                        )
                  },
                  {
                     id: "reserveTokens",
                     label: "Reserve tokens",
                     description: `Native Pi reserve for the active model: ${effLabel} effective window − ${formatTokens(effectiveTarget)} target. Written to settings.json; reload to apply.`,
                     currentValue: formatTokens(reserveTokens),
                     values: [formatTokens(reserveTokens)]
                  },

                  {
                     id: "maxContext",
                     label: "Max context",
                     description:
                        "Ceiling for models with larger native windows. Use no cap to keep provider sizes; per-model overrides can raise or remove it for specific models.",
                     currentValue: maxContextDisplay,
                     submenu: (_cv: string, submenuDone: (v?: string) => void) =>
                        new SelectSubmenu(
                           theme,
                           "Max Context",
                           "Maximum context window in tokens",
                           maxContextChoices(),
                           config.maxContext === NO_CAP ? "__nocap__" : String(config.maxContext),
                           (value: string) => {
                              applyConfig({ ...config, maxContext: tokenValue(value) });
                              submenuDone(value);
                           },
                           () => submenuDone(),
                           { customLabel: "max context" }
                        )
                  },
                  {
                     id: "modelOverrides",
                     label: "Model overrides",
                     description: `Per-model max context overrides (${overrideCount} active). Override or remove the global cap for specific models.`,
                     currentValue: overrideCount === 0 ? "none" : `${overrideCount} active`,
                     submenu: (_cv: string, submenuDone: (v?: string) => void) =>
                        new OverrideSubmenu(
                           theme,
                           () => submenuDone("updated"),
                           () => config,
                           applyConfig,
                           getOverrideModelChoices()
                        )
                  },

                  {
                     id: "summaryModelPrimary",
                     label: "Primary summary model",
                     description:
                        "Model that writes compaction summaries. Fast/cheap models work well; falls back automatically on failure.",
                     currentValue: slotLabel(slots[0]),
                     submenu: (_cv: string, submenuDone: (v?: string) => void) =>
                        new SelectSubmenu(
                           theme,
                           "Primary Summary Model",
                           "Model used for compaction summaries",
                           getSummaryModelChoices(),
                           slots[0],
                           (value: string) => {
                              setSlot(0, value);
                              submenuDone(value);
                           },
                           () => submenuDone()
                        )
                  },
                  {
                     id: "summaryModelFallback1",
                     label: "Fallback model 1",
                     description: "Second choice if the primary summary model fails.",
                     currentValue: slotLabel(slots[1]),
                     submenu: (_cv: string, submenuDone: (v?: string) => void) =>
                        new SelectSubmenu(
                           theme,
                           "Fallback Model 1",
                           "Used when the primary summary model fails",
                           getFallbackChoices(),
                           slots[1],
                           (value: string) => {
                              setSlot(1, value);
                              submenuDone(value);
                           },
                           () => submenuDone()
                        )
                  },
                  {
                     id: "summaryModelFallback2",
                     label: "Fallback model 2",
                     description: "Third choice if both primary and fallback 1 fail.",
                     currentValue: slotLabel(slots[2]),
                     submenu: (_cv: string, submenuDone: (v?: string) => void) =>
                        new SelectSubmenu(
                           theme,
                           "Fallback Model 2",
                           "Used when the primary and fallback 1 both fail",
                           getFallbackChoices(),
                           slots[2],
                           (value: string) => {
                              setSlot(2, value);
                              submenuDone(value);
                           },
                           () => submenuDone()
                        )
                  },
                  {
                     id: "summaryChain",
                     label: "Fallback chain",
                     description:
                        "Effective order: primary → fallback 1 → fallback 2 → active session model (final fallback).",
                     currentValue: chainDisplay,
                     values: [chainDisplay]
                  },

                  // ---- Actions ----
                  {
                     id: "reset",
                     label: "Reset to defaults",
                     description: `Restore maxContext=${formatTokens(DEFAULT_CONFIG.maxContext)}, target=${formatTokens(DEFAULT_CONFIG.compactionTarget)} and clear overrides and fallback models.`,
                     currentValue: "reset",
                     values: ["reset"]
                  }
               ];
            };

            const settingsListTheme = getSettingsListTheme();
            const items = buildItems();

            const settingsList = new SettingsList(
               items,
               10,
               settingsListTheme,
               (id: string, newValue: string) => {
                  if (id === "enabled") {
                     applyConfig({ ...config, enabled: newValue === "on" });
                  } else if (id === "reset") {
                     applyConfig({ ...DEFAULT_CONFIG });
                  }

                  // Refresh every displayed value because changing one setting can
                  // change the normalized target and the active-model reserve.
                  const refreshed = buildItems();
                  for (const item of refreshed) {
                     settingsList.updateValue(item.id, item.currentValue);
                  }
               },
               () => done()
            );

            const panel = new CompactionSettingsPanel(settingsList, theme);
            return panel;
         });
      }
   });
}

// ---------------------------------------------------------------------------
// TUI Components
// ---------------------------------------------------------------------------

type Option = { value: string; label: string; description?: string };

const NAV_KEYS = new Set(["\r", "\n", "\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "\x1b"]);

/** Parse a selected token value; "__nocap__" maps to the no-cap sentinel. */
function tokenValue(value: string): number {
   return value === "__nocap__" ? NO_CAP : parseInt(value, 10);
}

/** Size presets for per-model overrides, including no-cap and custom entries. */
function overrideSizeChoices(current: number | undefined): Option[] {
   const presets: Option[] = [
      { value: "__nocap__", label: "No cap (native)", description: "Leave this model uncapped" },
      { value: "32000", label: "32k", description: "32,000 tokens" },
      { value: "64000", label: "64k", description: "64,000 tokens" },
      { value: "96000", label: "96k", description: "96,000 tokens" },
      { value: "128000", label: "128k", description: "128,000 tokens" },
      { value: "200000", label: "200k", description: "200,000 tokens" },
      { value: "256000", label: "256k", description: "256,000 tokens" },
      { value: "512000", label: "512k", description: "512,000 tokens" },
      { value: "__custom__", label: "Custom value…", description: "Type any token count" }
   ];
   if (current === undefined || current === NO_CAP) return presets;
   const currentString = String(current);
   if (presets.some((p) => p.value === currentString)) return presets;
   return [
      { value: currentString, label: formatTokens(current), description: "Current override (custom)" },
      ...presets
   ];
}

/** Substring-filter a SelectList's displayed options. */
function filterOptions(selectList: SelectList, rawOptions: Option[], raw: string): void {
   const internals = selectList as unknown as { items: Option[]; filteredItems: Option[]; selectedIndex: number };
   const query = raw.toLowerCase().trim();
   if (!query) {
      internals.items = rawOptions;
      internals.filteredItems = rawOptions;
      internals.selectedIndex = 0;
      return;
   }
   const filtered = rawOptions.filter((opt) =>
      `${opt.value} ${opt.label} ${opt.description ?? ""}`.toLowerCase().includes(query)
   );
   internals.items = filtered;
   internals.filteredItems = filtered;
   internals.selectedIndex = 0;
}

/**
 * A submenu for selecting from a list of options with live search, expanded
 * columns, and an optional "Custom value…" entry that switches to free-form input.
 */
class SelectSubmenu implements Component {
   private searchInput?: Input;
   private customInput?: Input;
   private selectList: SelectList;
   private rawOptions: Option[];
   private mode: "list" | "custom" = "list";
   private hint: string;
   private enableSearch: boolean;

   constructor(
      private theme: Theme,
      private title: string,
      private description: string,
      options: Option[],
      currentValue: string,
      private onSelect: (value: string) => void,
      private onCancel: () => void,
      opts: { enableSearch?: boolean; customLabel?: string } = {}
   ) {
      this.rawOptions = options;
      this.enableSearch = opts.enableSearch ?? options.length > 5;
      if (this.enableSearch) {
         this.searchInput = new Input();
         this.searchInput.focused = true;
      }
      this.selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme(), {
         minPrimaryColumnWidth: 20,
         maxPrimaryColumnWidth: 60
      });
      const idx = options.findIndex((o) => o.value === currentValue);
      if (idx !== -1) this.selectList.setSelectedIndex(idx);
      this.selectList.onSelect = (item) => {
         if (item.value === "__custom__") {
            this.enterCustom();
            return;
         }
         this.onSelect(item.value);
      };
      this.selectList.onCancel = () => this.onCancel();
      this.hint = this.enableSearch
         ? "  Type to filter · ↑/↓ to navigate · Enter to select · Esc to go back"
         : "  Enter to select · Esc to go back";
   }

   private enterCustom(): void {
      this.mode = "custom";
      if (!this.customInput) this.customInput = new Input();
      this.customInput.focused = true;
      this.customInput.setValue("");
      this.hint = "  Type a token value · Enter to confirm · Esc to cancel";
   }

   handleInput(data: string): void {
      if (this.mode === "custom" && this.customInput) {
         if (data === "\r" || data === "\n") {
            const raw = this.customInput.getValue().trim();
            if (/^\d+$/.test(raw)) this.onSelect(raw);
            return;
         }
         if (data === "\x1b") {
            this.mode = "list";
            this.hint = this.enableSearch
               ? "  Type to filter · ↑/↓ to navigate · Enter to select · Esc to go back"
               : "  Enter to select · Esc to go back";
            return;
         }
         this.customInput.handleInput(data);
         return;
      }

      if (this.searchInput) {
         if (NAV_KEYS.has(data)) {
            this.selectList.handleInput(data);
            return;
         }
         this.searchInput.handleInput(data);
         filterOptions(this.selectList, this.rawOptions, this.searchInput.getValue());
         return;
      }
      this.selectList.handleInput(data);
   }

   render(width: number): string[] {
      const lines: string[] = [];
      lines.push(this.theme.bold(this.theme.fg("accent", this.title)));
      if (this.description) {
         lines.push("");
         lines.push(this.theme.fg("muted", this.description));
      }
      lines.push("");
      if (this.mode === "custom" && this.customInput) {
         lines.push(...this.customInput.render(width));
         lines.push("");
         lines.push(this.theme.fg("dim", this.hint));
         return lines;
      }
      if (this.searchInput) {
         lines.push(...this.searchInput.render(width));
         lines.push("");
      }
      lines.push(...this.selectList.render(width));
      lines.push("");
      lines.push(this.theme.fg("dim", this.hint));
      return lines;
   }

   invalidate(): void {
      this.selectList.invalidate();
   }
}

/**
 * Manage per-model max context overrides: add, edit, or remove overrides for
 * any model, all from the UI. Nested pickers navigate with Enter / Esc.
 */
class OverrideSubmenu implements Component {
   private levels: {
      title: string;
      description: string;
      options: Option[];
      preselect?: string;
      onSelect: (value: string) => void;
   }[] = [];
   private selectList!: SelectList;
   private searchInput?: Input;
   private customMode = false;
   private customInput?: Input;
   private customConfirm?: (value: string) => void;
   private hint = "  Enter to select · Esc to go back";

   constructor(
      private theme: Theme,
      private onDone: (value?: string) => void,
      private getConfig: () => CompactionConfig,
      private applyConfig: (config: CompactionConfig) => void,
      private modelChoices: Option[]
   ) {
      this.pushMain();
   }

   private get overrides(): Record<string, ModelOverride> {
      return this.getConfig().modelOverrides ?? {};
   }

   private pushMain(): void {
      const overrides = this.overrides;
      const keys = Object.keys(overrides);
      const options: Option[] = keys.map((key) => {
         const ov = overrides[key];
         const size =
            ov?.maxContext === NO_CAP
               ? "No cap (native)"
               : ov?.maxContext !== undefined
                 ? formatTokens(ov.maxContext)
                 : "?";
         return { value: `edit:${key}`, label: key, description: `${size} max context for this model` };
      });
      if (keys.length > 0) {
         options.push({ value: "clear", label: "Remove all overrides", description: "Clear every per-model override" });
      }
      options.push({ value: "add", label: "+ Add override", description: "Cap a specific model's native window" });
      this.levels = [
         {
            title: "Model Overrides",
            description:
               keys.length === 0
                  ? "No per-model overrides. The global Max context applies to every model."
                  : `${keys.length} override${keys.length === 1 ? "" : "s"} active. Select one to edit or remove it.`,
            options,
            onSelect: (value) => this.handleMain(value)
         }
      ];
      this.renderTop();
   }

   private handleMain(value: string): void {
      if (value === "add") {
         const available = this.modelChoices.filter((c) => !(c.value in this.overrides));
         if (available.length === 0) return;
         this.pushLevel({
            title: "Add Override",
            description: "Choose the model to override",
            options: available,
            onSelect: (key) => this.pushSize(key, undefined)
         });
         return;
      }
      if (value === "clear") {
         const next = { ...this.getConfig() };
         delete next.modelOverrides;
         this.applyConfig(next);
         this.pushMain();
         return;
      }
      if (value.startsWith("edit:")) {
         const key = value.slice(5);
         this.pushLevel({
            title: key,
            description: `Override for ${key}`,
            options: [
               { value: "edit-size", label: "Edit max context", description: "Change the override size" },
               {
                  value: "remove",
                  label: "Remove override",
                  description: "Restore the global max context for this model"
               }
            ],
            onSelect: (action) => {
               if (action === "edit-size") {
                  this.pushSize(key, this.overrides[key]?.maxContext);
               } else if (action === "remove") {
                  const next = { ...this.getConfig() };
                  const overrides = { ...next.modelOverrides };
                  delete overrides[key];
                  if (Object.keys(overrides).length === 0) delete next.modelOverrides;
                  else next.modelOverrides = overrides;
                  this.applyConfig(next);
                  this.pushMain();
               }
            }
         });
      }
   }

   private pushSize(key: string, current: number | undefined): void {
      this.pushLevel({
         title: "Override Max Context",
         description:
            current === undefined
               ? `Set the context ceiling for ${key}`
               : `Current override for ${key}: ${current === NO_CAP ? "no cap (native)" : formatTokens(current)}`,
         options: overrideSizeChoices(current),
         preselect: current === undefined ? undefined : String(current),
         onSelect: (value) => {
            const next = { ...this.getConfig() };
            const overrides = { ...next.modelOverrides };
            overrides[key] = { maxContext: tokenValue(value) };
            next.modelOverrides = overrides;
            this.applyConfig(next);
            this.pushMain();
         }
      });
   }

   private pushLevel(level: {
      title: string;
      description: string;
      options: Option[];
      preselect?: string;
      onSelect: (value: string) => void;
   }): void {
      this.levels.push(level);
      this.renderTop();
   }

   private pop(): void {
      if (this.levels.length > 1) {
         this.levels.pop();
         this.renderTop();
      }
   }

   private renderTop(): void {
      const level = this.levels[this.levels.length - 1];
      const hasSearch = level.options.length > 5;
      if (hasSearch && !this.searchInput) this.searchInput = new Input();
      if (this.searchInput) {
         this.searchInput.focused = true;
         this.searchInput.setValue("");
      }
      this.selectList = new SelectList(level.options, Math.min(level.options.length, 10), getSelectListTheme(), {
         minPrimaryColumnWidth: 20,
         maxPrimaryColumnWidth: 60
      });
      if (level.preselect) {
         const idx = level.options.findIndex((o) => o.value === level.preselect);
         if (idx !== -1) this.selectList.setSelectedIndex(idx);
      }
      this.selectList.onSelect = (item) => {
         if (item.value === "__custom__") {
            this.customConfirm = (raw) => level.onSelect(raw);
            this.enterCustom();
            return;
         }
         level.onSelect(item.value);
      };
      this.selectList.onCancel = () => {
         if (this.levels.length > 1) this.pop();
         else this.onDone("updated");
      };
      this.hint = hasSearch
         ? "  Type to filter · ↑/↓ to navigate · Enter to select · Esc to go back"
         : "  Enter to select · Esc to go back";
   }

   private enterCustom(): void {
      this.customMode = true;
      if (!this.customInput) this.customInput = new Input();
      this.customInput.focused = true;
      this.customInput.setValue("");
      this.hint = "  Type a token value · Enter to confirm · Esc to cancel";
   }

   handleInput(data: string): void {
      if (this.customMode && this.customInput) {
         if (data === "\r" || data === "\n") {
            const raw = this.customInput.getValue().trim();
            if (/^\d+$/.test(raw)) {
               const confirm = this.customConfirm;
               this.customMode = false;
               if (confirm) confirm(raw);
            }
            return;
         }
         if (data === "\x1b") {
            this.customMode = false;
            this.hint = "  Enter to select · Esc to go back";
            return;
         }
         this.customInput.handleInput(data);
         return;
      }

      const level = this.levels[this.levels.length - 1];
      if (this.searchInput && level.options.length > 5) {
         if (NAV_KEYS.has(data)) {
            this.selectList.handleInput(data);
            return;
         }
         this.searchInput.handleInput(data);
         filterOptions(this.selectList, level.options, this.searchInput.getValue());
         return;
      }
      this.selectList.handleInput(data);
   }

   render(width: number): string[] {
      const level = this.levels[this.levels.length - 1];
      const lines: string[] = [];
      lines.push(this.theme.bold(this.theme.fg("accent", level.title)));
      if (level.description) {
         lines.push("");
         lines.push(this.theme.fg("muted", level.description));
      }
      lines.push("");
      if (this.customMode && this.customInput) {
         lines.push(...this.customInput.render(width));
         lines.push("");
         lines.push(this.theme.fg("dim", this.hint));
         return lines;
      }
      if (this.searchInput) {
         lines.push(...this.searchInput.render(width));
         lines.push("");
      }
      lines.push(...this.selectList.render(width));
      lines.push("");
      lines.push(this.theme.fg("dim", this.hint));
      return lines;
   }

   invalidate(): void {
      this.selectList.invalidate();
   }
}

/**
 * Panel wrapping the SettingsList with a title and borders.
 */
class CompactionSettingsPanel extends Container {
   private settingsList: SettingsList;

   constructor(
      settingsList: SettingsList,
      private theme: Theme
   ) {
      super();
      this.addChild(new DynamicBorder());
      this.addChild(new Text(theme.bold(theme.fg("accent", "  Compaction Settings")), 0, 0));
      this.addChild(new Spacer(1));
      this.settingsList = settingsList;
      this.addChild(this.settingsList);
      this.addChild(new DynamicBorder());
   }

   handleInput(data: string): void {
      this.settingsList.handleInput(data);
   }
}
