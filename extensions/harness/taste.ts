/**
 * Taste System Extension
 *
 * Continuously learns your coding patterns from session activity and
 * injects them into the system prompt so the model adapts to your style.
 *
 * Stores taste profile in .pi/taste/taste.md organized by language/domain.
 *
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface TasteProfile {
   styles: string[];
   patterns: string[];
   frameworks: string[];
   conventions: string[];
}

interface TasteFile {
   version: number;
   updatedAt: number;
   sessionCount: number;
   languages: Record<string, TasteProfile>;
   project: TasteProfile;
}

export default function (pi: ExtensionAPI) {
   const LEARN_INTERVAL_MS = 30_000; // Don't learn more than once per 30s per session
   let lastLearnTime = 0;
   let widgetOpen = false;

   function getTasteDir(ctx: { cwd: string }): string {
      return join(ctx.cwd, ".pi", "taste");
   }

   function getTastePath(ctx: { cwd: string }): string {
      return join(getTasteDir(ctx), "taste.md");
   }

   function ensureTasteDir(ctx: { cwd: string }): void {
      const dir = getTasteDir(ctx);
      if (!existsSync(dir)) {
         mkdirSync(dir, { recursive: true });
      }
   }

   function loadTaste(ctx: { cwd: string }): { profile: TasteProfile | null; sessionCount: number } {
      const path = getTastePath(ctx);
      if (!existsSync(path)) return { profile: null, sessionCount: 0 };
      try {
         const raw = readFileSync(path, "utf-8");
         const parsed: TasteFile = JSON.parse(raw);
         return { profile: parsed.project, sessionCount: parsed.sessionCount ?? 0 };
      } catch {
         return { profile: null, sessionCount: 0 };
      }
   }

   function saveTaste(ctx: { cwd: string }, profile: TasteProfile, sessionCount: number): void {
      const data: TasteFile = {
         version: 1,
         updatedAt: Date.now(),
         sessionCount,
         languages: {},
         project: profile
      };
      ensureTasteDir(ctx);
      writeFileSync(getTastePath(ctx), JSON.stringify(data, null, 2), "utf-8");
   }

   function formatTasteForPrompt(profile: TasteProfile): string {
      if (!profile || profile.styles.length + profile.patterns.length + profile.frameworks.length === 0) {
         return "";
      }

      const lines: string[] = ["## Your Coding Style (learned)", ""];
      if (profile.frameworks.length) {
         lines.push("**Frameworks & tools you prefer:**");
         profile.frameworks.forEach((f) => lines.push(`- ${f}`));
         lines.push("");
      }
      if (profile.styles.length) {
         lines.push("**Styling conventions:**");
         profile.styles.forEach((s) => lines.push(`- ${s}`));
         lines.push("");
      }
      if (profile.patterns.length) {
         lines.push("**Architectural patterns:**");
         profile.patterns.forEach((p) => lines.push(`- ${p}`));
         lines.push("");
      }
      if (profile.conventions.length) {
         lines.push("**Naming & code conventions:**");
         profile.conventions.forEach((c) => lines.push(`- ${c}`));
         lines.push("");
      }
      return lines.join("\n");
   }

   function extractRecentActivity(
      entries: Array<{ type: string; message?: { role?: string; content?: unknown } }>
   ): string {
      const parts: string[] = [];
      let count = 0;

      for (let i = entries.length - 1; i >= 0 && count < 10; i--) {
         const e = entries[i];
         if (e.type !== "message" || !e.message?.content) continue;

         const content = e.message.content;
         const text = typeof content === "string" ? content : extractTextFromParts(content as Array<unknown>);
         if (!text.trim()) continue;

         const role = e.message.role === "user" ? "User" : e.message.role === "assistant" ? "Assistant" : null;
         if (!role) continue;

         parts.unshift(`[${role}]: ${text.trim().slice(0, 300)}`);
         count++;
      }

      return parts.join("\n\n");
   }

   function extractTextFromParts(parts: unknown[]): string {
      return parts
         .filter((p): p is { type: string; text?: string } => typeof p === "object" && p !== null)
         .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
         .join(" ");
   }

   function extractToolToolCalls(entries: Array<{ type: string; message?: { content?: unknown } }>): string[] {
      const tools = new Set<string>();
      for (const e of entries) {
         if (e.type !== "message" || !e.message?.content) continue;
         const parts = Array.isArray(e.message.content) ? e.message.content : [];
         for (const p of parts) {
            if (
               typeof p === "object" &&
               p !== null &&
               "type" in p &&
               p.type === "toolCall" &&
               "name" in p &&
               typeof p.name === "string"
            ) {
               tools.add(p.name);
            }
         }
      }
      return [...tools];
   }

   // Learn from session on agent_end
   pi.on("agent_end", async (event, ctx) => {
      if (!ctx.hasUI) return;
      const now = Date.now();
      if (now - lastLearnTime < LEARN_INTERVAL_MS) return;
      lastLearnTime = now;

      const entries = ctx.sessionManager.getEntries() as any[];
      if (entries.length < 2) return;

      const activity = extractRecentActivity(entries);
      if (!activity) return;

      const toolsUsed = extractToolToolCalls(entries);

      // Use a lightweight model to analyze patterns
      const model = ctx.modelRegistry.find("google", "gemini-3.1-flash-lite");
      if (!model) return;

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return;

      // Existing taste context
      const existing = loadTaste(ctx);
      const existingText = existing.profile ? formatTasteForPrompt(existing.profile) : "No previous data.";

      const analysisMessages = [
         {
            role: "user" as const,
            content: [
               {
                  type: "text" as const,
                  text: `You analyze coding sessions to extract a user's taste profile. Update the existing profile below with any new patterns from the recent session.

EXISTING PROFILE:
${existingText}

RECENT SESSION ACTIVITY (last 10 messages):
${activity}

TOOLS USED: ${toolsUsed.join(", ") || "none"}

Respond with a JSON object only (no markdown):
{
  "styles": ["styling conventions observed"],
  "patterns": ["architectural or code patterns observed"],
  "frameworks": ["libraries/frameworks observed"],
  "conventions": ["naming conventions, formatting, or code rules observed"]
}

Combine existing and new observations. Remove nothing. Deduplicate. If nothing new, still return the existing data.`
               }
            ],
            timestamp: now
         }
      ];

      try {
         const response = await complete(
            model,
            { messages: analysisMessages },
            { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 2048 }
         );

         const text = response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");

         const jsonMatch = text.match(/\{[\s\S]*\}/);
         if (!jsonMatch) return;

         const merged: TasteProfile = JSON.parse(jsonMatch[0]);

         // Merge with existing
         const existingData = loadTaste(ctx);
         const profile = existingData.profile ?? {
            styles: [],
            patterns: [],
            frameworks: [],
            conventions: []
         };
         const count = (existingData.sessionCount ?? 0) + 1;

         profile.styles = [...new Set([...profile.styles, ...(merged.styles ?? [])])];
         profile.patterns = [...new Set([...profile.patterns, ...(merged.patterns ?? [])])];
         profile.frameworks = [...new Set([...profile.frameworks, ...(merged.frameworks ?? [])])];
         profile.conventions = [...new Set([...profile.conventions, ...(merged.conventions ?? [])])];

         saveTaste(ctx, profile, count);
      } catch {
         // Silently fail - taste learning is best-effort
      }
   });

   // Inject taste into system prompt
   pi.on("before_agent_start", async (event, ctx) => {
      const { profile } = loadTaste(ctx);
      if (!profile) return { systemPrompt: event.systemPrompt };

      const tasteText = formatTasteForPrompt(profile);
      if (!tasteText) return { systemPrompt: event.systemPrompt };

      return {
         systemPrompt: `${event.systemPrompt}\n${tasteText}`
      };
   });

   // Command to view/close taste widget
   pi.registerCommand("taste", {
      description: "Toggle learned coding taste profile",
      handler: async (_args, ctx) => {
         if (widgetOpen) {
            ctx.ui.setWidget("taste", undefined);
            widgetOpen = false;
            return;
         }

         const { profile, sessionCount } = loadTaste(ctx);
         if (!profile || profile.styles.length + profile.patterns.length + profile.frameworks.length === 0) {
            ctx.ui.notify("No taste data yet. Continue coding to build your profile.", "info");
            return;
         }
         const text = formatTasteForPrompt(profile);
         ctx.ui.notify(`Taste profile (${sessionCount} sessions analyzed):`, "info");
         ctx.ui.setWidget("taste", text.split("\n"));
         widgetOpen = true;
      }
   });

   // Command to reset taste
   pi.registerCommand("taste-reset", {
      description: "Reset learned taste profile",
      handler: async (_args, ctx) => {
         const empty: TasteProfile = { styles: [], patterns: [], frameworks: [], conventions: [] };
         saveTaste(ctx, empty, 0);
         ctx.ui.setWidget("taste", undefined);
         widgetOpen = false;
         ctx.ui.notify("Taste profile reset.", "info");
      }
   });
}
