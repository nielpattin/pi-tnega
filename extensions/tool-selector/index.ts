/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

// State persisted to session
interface ToolsState {
   enabledTools: string[];
}

function isToolsState(value: unknown): value is ToolsState {
   return typeof value === "object" && value !== null && "enabledTools" in value;
}

export default function toolsExtension(pi: ExtensionAPI) {
   // Track enabled tools
   let enabledTools: Set<string> = new Set();
   let allTools: ToolInfo[] = [];
   const defaultBuiltInTools = ["read", "bash", "edit", "write"];
   let hasSavedToolsConfig = false;

   function withDefaultBuiltins(tools: string[], allToolNames: string[]): string[] {
      const next = new Set(tools.filter((tool) => allToolNames.includes(tool)));
      for (const tool of defaultBuiltInTools) {
         if (allToolNames.includes(tool)) {
            next.add(tool);
         }
      }
      return Array.from(next);
   }

   function isDefaultDisabledBuiltInTool(toolName: string): boolean {
      const tool = allTools.find((tool) => tool.name === toolName);
      return tool?.sourceInfo.source === "builtin" && !defaultBuiltInTools.includes(toolName);
   }

   function hasPromptGuidelines(toolName: string): boolean {
      const tool = allTools.find((tool) => tool.name === toolName) as
         | (ToolInfo & { promptGuidelines?: string[] })
         | undefined;
      return tool?.promptGuidelines?.some((guideline: string) => guideline.trim().length > 0) ?? false;
   }

   function hasPromptSnippet(toolName: string, toolSnippets: Record<string, string> | undefined): boolean {
      return typeof toolSnippets?.[toolName] === "string" && toolSnippets[toolName].trim().length > 0;
   }

   function sameTools(left: string[], right: string[]): boolean {
      return left.length === right.length && left.every((tool, index) => tool === right[index]);
   }

   function pruneAutoActiveUnguidedTools(toolSnippets: Record<string, string> | undefined) {
      if (hasSavedToolsConfig) {
         return;
      }

      allTools = pi.getAllTools();
      const allToolNames = allTools.map((t) => t.name);
      const baseTools = pi
         .getActiveTools()
         .filter(
            (tool: string) =>
               allToolNames.includes(tool) &&
               !isDefaultDisabledBuiltInTool(tool) &&
               (defaultBuiltInTools.includes(tool) || hasPromptSnippet(tool, toolSnippets) || hasPromptGuidelines(tool))
         );
      const nextTools = withDefaultBuiltins(baseTools, allToolNames);
      if (sameTools(Array.from(enabledTools), nextTools)) {
         return;
      }

      enabledTools = new Set(nextTools);
      applyTools();
   }

   // Persist current state
   function persistState() {
      pi.appendEntry<ToolsState>("tools-config", {
         enabledTools: Array.from(enabledTools)
      });
   }

   // Apply current tool selection
   function applyTools() {
      pi.setActiveTools(Array.from(enabledTools));
   }

   // Find the last tools-config entry in the current branch
   function restoreFromBranch(ctx: ExtensionContext) {
      allTools = pi.getAllTools();
      const allToolNames = allTools.map((t) => t.name);

      // Get entries in current branch only
      const branchEntries = ctx.sessionManager.getBranch();
      let savedTools: string[] | undefined;

      for (const entry of branchEntries) {
         if (entry.type === "custom" && entry.customType === "tools-config") {
            const data = entry.data;
            if (isToolsState(data) && data.enabledTools) {
               savedTools = data.enabledTools;
            }
         }
      }

      hasSavedToolsConfig = savedTools !== undefined;

      const restoredTools = savedTools ?? pi.getActiveTools();
      const baseTools = restoredTools.filter(
         (tool: string) =>
            allToolNames.includes(tool) && (savedTools !== undefined || !isDefaultDisabledBuiltInTool(tool))
      );
      enabledTools = new Set(withDefaultBuiltins(baseTools, allToolNames));
      applyTools();
   }

   // Register /tools command
   pi.registerCommand("tools", {
      description: "Enable/disable tools",
      handler: async (_args, ctx) => {
         // Refresh tool list
         allTools = pi.getAllTools();

         await ctx.ui.custom((tui, theme, _kb, done) => {
            // Build settings items for each tool
            const items: SettingItem[] = allTools.map((tool) => ({
               id: tool.name,
               label: tool.name,
               currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
               values: ["enabled", "disabled"]
            }));

            const container = new Container();
            container.addChild(
               new (class {
                  render(_width: number) {
                     return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
                  }
                  invalidate() {}
               })()
            );

            const settingsList = new SettingsList(
               items,
               Math.min(items.length + 2, 15),
               getSettingsListTheme(),
               (id, newValue) => {
                  // Update enabled state and apply immediately
                  if (newValue === "enabled") {
                     enabledTools.add(id);
                  } else {
                     enabledTools.delete(id);
                  }
                  applyTools();
                  persistState();
                  hasSavedToolsConfig = true;
               },
               () => {
                  // Close dialog
                  done(undefined);
               }
            );

            container.addChild(settingsList);

            const component = {
               render(width: number) {
                  return container.render(width);
               },
               invalidate() {
                  container.invalidate();
               },
               handleInput(data: string) {
                  settingsList.handleInput?.(data);
                  tui.requestRender();
               }
            };

            return component;
         });
      }
   });

   // Restore state on session start
   pi.on("session_start", async (_event, ctx) => {
      restoreFromBranch(ctx);
   });

   pi.on("before_agent_start", async (event) => {
      pruneAutoActiveUnguidedTools(event.systemPromptOptions.toolSnippets);
   });

   // Restore state when navigating the session tree
   pi.on("session_tree", async (_event, ctx) => {
      restoreFromBranch(ctx);
   });
}
