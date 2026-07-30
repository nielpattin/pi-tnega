import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Ref } from "effect";
import type { AgentDefinition, HarnessName } from "../domain.js";

export interface VibeProfileConfig {
   harness: HarnessName;
   pi?: {
      model?: string;
      reasoning_effort?: string;
      tools?: string[];
      body?: string;
   };
   agy?: {
      model?: string;
      reasoning_effort?: string;
      tools?: string[];
      body?: string;
   };
   tools?: string[];
   body?: string;
}

export interface AgentsStoreShape {
   readonly getAgent: (name: string, cwd?: string) => Effect.Effect<AgentDefinition | undefined>;
   readonly listAgents: (cwd?: string) => Effect.Effect<ReadonlyArray<AgentDefinition>>;
   readonly getVibeProfiles: (cwd?: string) => Effect.Effect<{ fast: VibeProfileConfig; good: VibeProfileConfig }>;
   readonly updateAgent: (agent: AgentDefinition, cwd?: string) => Effect.Effect<AgentDefinition>;
   readonly deleteAgent: (name: string, cwd?: string) => Effect.Effect<{ success: boolean; error?: string }>;
   readonly updateVibeProfile: (
      name: "fast" | "good",
      profile: VibeProfileConfig,
      cwd?: string
   ) => Effect.Effect<VibeProfileConfig>;
}

export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
   fast: {
      name: "fast",
      display_name: "fast",
      description: "Vibe director profile for quick research and light edits.",
      tools: ["read", "write", "edit", "grep", "find", "submit", "hub"],
      guidance: "Use for quick research and light edits.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      kind: "vibe",
      body: ""
   },
   good: {
      name: "good",
      display_name: "good",
      description: "Vibe director profile for complex implementation.",
      tools: ["read", "grep", "find", "ls", "submit", "hub"],
      guidance: "Use for complex implementation work.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      kind: "vibe",
      body: ""
   },
   scout: {
      name: "scout",
      display_name: "scout",
      description: "Read-only codebase research agent for rapid exploration and analysis.",
      tools: ["read", "grep", "find", "web_search_exa", "web_fetch_exa"],
      guidance: "Read-only research scout returning compressed context.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: `# SCOUT AGENT

Investigate the codebase rapidly. Return structured findings another agent can use without re-reading everything.

## Directives
- You MUST use tools for broad pattern matching / code search as much as possible.
- You SHOULD invoke tools in parallel — this is a short investigation; finish in a few seconds when possible.
- If a search returns empty results, you MUST try at least one alternate strategy (different pattern, broader path) before concluding the target doesn't exist.

## Thoroughness
Infer thoroughness from the task; default to medium:
- Quick: Targeted lookups, key files only
- Medium: Follow imports, read critical sections
- Thorough: Trace dependencies, check tests/types

## Procedure
1. Locate relevant code using tools.
2. Read key sections. NEVER read full files unless they're tiny.
3. Identify types/interfaces/key functions.
4. Note dependencies between files.

## Critical
You MUST operate as read-only. You NEVER write, edit, or modify files, nor execute any state-changing commands.
You MUST keep going until complete.

## Output
Return:
- Summary of findings
- Files examined with path references
- Brief architecture notes on how pieces connect`
   },
   task: {
      name: "task",
      display_name: "task",
      description: "General-purpose worker for delegated implementation tasks with full tool access.",
      tools: ["read", "write", "edit", "bash", "grep", "find", "hub", "web_search_exa", "web_fetch_exa"],
      guidance: "Use for delegated implementation work that needs full tools.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: `# TASK AGENT

You are a worker agent for delegated tasks.

You have FULL access to tools (edit, write, bash, grep, read, etc.) and you MUST use them as needed to complete your task.

You MUST maintain hyperfocus on the assigned task. NEVER deviate from it.

## Directives
- Finish only the assigned work and return the minimum useful result. Do not repeat what you have written to the filesystem.
- Make file edits, run commands, and create files when your task requires it.
- Be concise. NEVER include filler, repetition, or tool transcripts. The parent agent cannot see your intermediate noise.
- Prefer narrow lookups (grep/find), then read only the needed ranges. Ignore anything beyond current scope.
- Avoid full-file reads unless necessary.
- Prefer edits to existing files over creating new ones.
- NEVER create documentation files (*.md) unless explicitly requested.
- Follow the assignment and instructions given to you.

## Output
Return a short completion note: what changed, which paths, anything the parent must know next.`
   },
   reviewer: {
      name: "reviewer",
      display_name: "reviewer",
      description: "Code review agent that evaluates git changes and PR diffs.",
      tools: ["read", "grep", "find", "hub"],
      guidance: "Review agent evaluating code diffs and safety boundaries.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: `# REVIEWER AGENT

Evaluate code changes and pull request diffs.

## Directives
- Check for regression risks, missing null checks, edge cases, and architectural consistency.
- Provide clear actionable review feedback.`
   }
};

export const DEFAULT_VIBE_PROFILES: { fast: VibeProfileConfig; good: VibeProfileConfig } = {
   fast: {
      harness: "pi",
      pi: {
         tools: ["read", "write", "edit", "grep", "find"]
      }
   },
   good: {
      harness: "pi",
      pi: {
         tools: ["read", "write", "edit", "grep", "find", "hub"]
      }
   }
};

function parseYamlFrontmatter(fmText: string): Record<string, string> {
   const result: Record<string, string> = {};
   for (const line of fmText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex === -1) continue;
      const key = trimmed.slice(0, colonIndex).trim();
      let value = trimmed.slice(colonIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
         value = value.slice(1, -1);
      }
      result[key] = value;
   }
   return result;
}

export function parseAgentMarkdown(name: string, content: string, filePath?: string): AgentDefinition | null {
   let fmText = "";
   let bodyText = content;

   if (content.startsWith("---")) {
      const endFm = content.indexOf("\n---", 3);
      if (endFm !== -1) {
         fmText = content.slice(3, endFm).trim();
         bodyText = content.slice(endFm + 4);
      }
   }

   const body = bodyText.trim();
   const kv = parseYamlFrontmatter(fmText);
   const kind = kv.kind === "vibe" || BUILTIN_AGENTS[name]?.kind === "vibe" ? "vibe" : "agent";
   // Empty vibe body means inherit the parent session's effective system prompt.
   if (!body && kind !== "vibe") return null;

   const description = kv.description ?? "";
   const display_name = kv.display_name || undefined;
   let tools: string[] | undefined = undefined;
   if (kv.tools !== undefined && kv.tools.trim() !== "") {
      tools = kv.tools
         .split(",")
         .map((t) => t.trim())
         .filter(Boolean);
   }
   const model = kv.model || undefined;
   const thinking = kv.thinking || undefined;
   const guidance = kv.guidance || undefined;
   const harness: HarnessName = kv.harness === "agy" ? "agy" : "pi";
   const enabled = kv.enabled !== undefined ? kv.enabled.toLowerCase() === "true" : true;
   const isBuiltin = Boolean(BUILTIN_AGENTS[name]);

   return {
      name,
      description,
      display_name,
      tools: tools ?? [],
      model,
      thinking,
      guidance,
      harness,
      enabled,
      source: isBuiltin ? "builtin" : filePath?.includes(".pi/agents") ? "project" : "global",
      kind,
      body,
      filePath
   };
}

export function serializeAgentMarkdown(def: AgentDefinition): string {
   const lines: string[] = ["---"];
   lines.push(`description: ${def.description || ""}`);
   if (def.display_name) lines.push(`display_name: ${def.display_name}`);
   if (def.tools && def.tools.length > 0) {
      lines.push(`tools: ${def.tools.join(", ")}`);
   }
   if (def.model) lines.push(`model: ${def.model}`);
   if (def.thinking) lines.push(`thinking: ${def.thinking}`);
   if (def.guidance) lines.push(`guidance: ${def.guidance}`);
   if (def.kind === "vibe") lines.push("kind: vibe");
   lines.push(`harness: ${def.harness || "pi"}`);
   lines.push(`enabled: ${def.enabled ? "true" : "false"}`);
   lines.push("---");
   lines.push("");
   lines.push(
      def.kind === "vibe" ? def.body : def.body || `# ${def.name.toUpperCase()} AGENT\n\nDefault agent instructions.`
   );
   lines.push("");
   return lines.join("\n");
}

export function getGlobalAgentsDir(): string {
   return path.join(getAgentDir(), "agents");
}

export function getProjectAgentsDir(cwd?: string): string | null {
   return cwd ? path.join(cwd, ".pi", "agents") : null;
}

export function loadAllAgentsFromDisk(cwd?: string): AgentDefinition[] {
   const agentsMap = new Map<string, AgentDefinition>();
   for (const b of Object.values(BUILTIN_AGENTS)) {
      agentsMap.set(b.name, { ...b, scope: "builtin", scopes: [] });
   }

   const dirsToScan: { dir: string; scope: "project" | "global" }[] = [{ dir: getGlobalAgentsDir(), scope: "global" }];
   if (cwd) {
      dirsToScan.push({ dir: path.join(cwd, "agents"), scope: "project" });
      const projDir = getProjectAgentsDir(cwd);
      if (projDir) dirsToScan.push({ dir: projDir, scope: "project" });
   }

   for (const item of dirsToScan) {
      if (!fs.existsSync(item.dir)) continue;
      try {
         for (const file of fs.readdirSync(item.dir)) {
            if (file.endsWith(".md")) {
               const name = path.basename(file, ".md");
               const filePath = path.join(item.dir, file);
               try {
                  const content = fs.readFileSync(filePath, "utf-8");
                  const parsed = parseAgentMarkdown(name, content, filePath);
                  if (parsed) {
                     const existing = agentsMap.get(name);
                     const isBuiltin = Boolean(BUILTIN_AGENTS[name]);

                     let finalScope: "project" | "global" | "both" | "builtin" = item.scope;
                     let finalScopes: ("project" | "global")[] = [item.scope];

                     if (existing && existing.scope !== "builtin" && existing.scope !== item.scope) {
                        finalScope = "both";
                        finalScopes = ["project", "global"];
                     }

                     if (isBuiltin) {
                        agentsMap.set(name, {
                           ...parsed,
                           source: "builtin",
                           scope: finalScope,
                           scopes: finalScopes,
                           isOverride: true,
                           filePath
                        });
                     } else {
                        agentsMap.set(name, {
                           ...parsed,
                           scope: finalScope,
                           scopes: finalScopes,
                           filePath
                        });
                     }
                  }
               } catch {}
            }
         }
      } catch {}
   }

   return Array.from(agentsMap.values());
}

export function saveAgentToDisk(agent: AgentDefinition, cwd?: string): string {
   const globalDir = getGlobalAgentsDir();
   if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
   const globalPath = path.join(globalDir, `${agent.name}.md`);
   fs.writeFileSync(globalPath, serializeAgentMarkdown({ ...agent, scope: "global", scopes: ["global"] }), "utf-8");

   // Clean up any stale project-local file if it exists (only if different from globalPath)
   if (cwd) {
      const projDir = getProjectAgentsDir(cwd);
      if (projDir) {
         const p = path.join(projDir, `${agent.name}.md`);
         if (path.resolve(p) !== path.resolve(globalPath) && fs.existsSync(p))
            try {
               fs.unlinkSync(p);
            } catch {}
      }
      const altP = path.join(cwd, "agents", `${agent.name}.md`);
      if (path.resolve(altP) !== path.resolve(globalPath) && fs.existsSync(altP))
         try {
            fs.unlinkSync(altP);
         } catch {}
   }

   return globalPath;
}

export function deleteAgentFromDisk(
   agentOrName: AgentDefinition | string,
   cwd?: string
): { success: boolean; error?: string } {
   const agentName = typeof agentOrName === "string" ? agentOrName : agentOrName.name;
   const filePath = typeof agentOrName === "object" ? agentOrName.filePath : undefined;

   let deleted = false;
   if (filePath && fs.existsSync(filePath)) {
      try {
         fs.unlinkSync(filePath);
         deleted = true;
      } catch (e) {
         return { success: false, error: String(e) };
      }
   }

   if (!deleted && cwd) {
      const projDir = getProjectAgentsDir(cwd);
      if (projDir) {
         const p = path.join(projDir, `${agentName}.md`);
         if (fs.existsSync(p)) {
            try {
               fs.unlinkSync(p);
               deleted = true;
            } catch (e) {
               return { success: false, error: String(e) };
            }
         }
      }
      const altP = path.join(cwd, "agents", `${agentName}.md`);
      if (fs.existsSync(altP)) {
         try {
            fs.unlinkSync(altP);
            deleted = true;
         } catch (e) {
            return { success: false, error: String(e) };
         }
      }
   }

   if (!deleted) {
      const p = path.join(getGlobalAgentsDir(), `${agentName}.md`);
      if (fs.existsSync(p)) {
         try {
            fs.unlinkSync(p);
            deleted = true;
         } catch (e) {
            return { success: false, error: String(e) };
         }
      }
   }

   return deleted ? { success: true } : { success: false, error: `Agent file for "${agentName}" not found.` };
}

function vibeProfileToDefinition(name: "fast" | "good", profile: VibeProfileConfig): AgentDefinition {
   const active = profile.harness === "agy" ? profile.agy : profile.pi;
   const builtin = BUILTIN_AGENTS[name];
   return {
      ...builtin,
      name,
      display_name: name,
      description: builtin.description,
      tools: active?.tools ?? profile.tools ?? builtin.tools,
      harness: profile.harness,
      enabled: true,
      source: "builtin",
      kind: "vibe",
      model: active?.model ?? builtin.model,
      thinking: active?.reasoning_effort ?? builtin.thinking,
      body: active?.body ?? profile.body ?? ""
   };
}

function definitionToVibeProfile(definition: AgentDefinition): VibeProfileConfig {
   const active = {
      model: definition.model,
      reasoning_effort: definition.thinking,
      tools: [...definition.tools],
      body: definition.body || undefined
   };
   return definition.harness === "agy"
      ? { harness: "agy", agy: active, tools: [...definition.tools], body: definition.body || undefined }
      : { harness: "pi", pi: active, tools: [...definition.tools], body: definition.body || undefined };
}

/** One-time migration. Markdown becomes the only persistent format, then agents.json is removed. */
export function migrateAgentsJsonToMarkdown(cwd?: string): void {
   const paths = [path.join(getAgentDir(), "agents.json")];
   if (cwd) paths.push(path.join(cwd, "agents.json"));

   for (const configPath of new Set(paths)) {
      if (!fs.existsSync(configPath)) continue;
      try {
         const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
         for (const name of ["fast", "good"] as const) {
            const profile = raw?.profiles?.[name] as VibeProfileConfig | undefined;
            if (profile) saveAgentToDisk(vibeProfileToDefinition(name, profile), cwd);
         }
         fs.unlinkSync(configPath);
      } catch {
         // Keep an unreadable file intact so migration never destroys recoverable user data.
      }
   }
}

/** Compatibility read API. Values now come exclusively from fast.md / good.md. */
export function loadAgentsConfigFromDisk(cwd?: string): { fast: VibeProfileConfig; good: VibeProfileConfig } {
   migrateAgentsJsonToMarkdown(cwd);
   const agents = loadAllAgentsFromDisk(cwd);
   const fast = agents.find((agent) => agent.name === "fast") ?? BUILTIN_AGENTS.fast;
   const good = agents.find((agent) => agent.name === "good") ?? BUILTIN_AGENTS.good;
   return {
      fast: definitionToVibeProfile(fast),
      good: definitionToVibeProfile(good)
   };
}

/** Compatibility write API. Writes normal Markdown agent overrides, never agents.json. */
export function saveAgentsConfigToDisk(vibe: { fast: VibeProfileConfig; good: VibeProfileConfig }, cwd?: string): void {
   saveAgentToDisk(vibeProfileToDefinition("fast", vibe.fast), cwd);
   saveAgentToDisk(vibeProfileToDefinition("good", vibe.good), cwd);
}

export class AgentsStore extends Context.Service<AgentsStore, AgentsStoreShape>()("harbor/AgentsStore") {
   static readonly layer = Layer.effect(
      AgentsStore,
      Effect.gen(function* () {
         const agentsRef = yield* Ref.make({ ...BUILTIN_AGENTS } as Record<string, AgentDefinition>);
         const vibeRef = yield* Ref.make({
            fast: { ...DEFAULT_VIBE_PROFILES.fast },
            good: { ...DEFAULT_VIBE_PROFILES.good }
         });

         const getAgent = Effect.fn("AgentsStore.getAgent")(function* (name: string, cwd?: string) {
            migrateAgentsJsonToMarkdown(cwd);
            const list = loadAllAgentsFromDisk(cwd);
            const found = list.find((a) => a.name === name);
            if (found) return found;
            const agents = yield* Ref.get(agentsRef);
            return agents[name];
         });

         const listAgents = Effect.fn("AgentsStore.listAgents")(function* (cwd?: string) {
            migrateAgentsJsonToMarkdown(cwd);
            // Disk wins over in-memory. loadAllAgentsFromDisk already seeds
            // builtins, then overlays global/project files (with isOverride).
            // In-memory only fills names not present on disk so session-local
            // updates that have not been written yet still appear.
            const diskAgents = loadAllAgentsFromDisk(cwd);
            const inMemory = yield* Ref.get(agentsRef);
            const map = new Map<string, AgentDefinition>();
            for (const a of Object.values(inMemory)) {
               map.set(a.name, a);
            }
            for (const a of diskAgents) map.set(a.name, a);
            return Array.from(map.values());
         });

         const getVibeProfiles = Effect.fn("AgentsStore.getVibeProfiles")(function* (cwd?: string) {
            yield* Effect.void;
            const diskVibe = loadAgentsConfigFromDisk(cwd);
            return diskVibe;
         });

         const updateAgent = Effect.fn("AgentsStore.updateAgent")(function* (agent: AgentDefinition, cwd?: string) {
            saveAgentToDisk(agent, cwd);
            yield* Ref.update(agentsRef, (prev) => ({ ...prev, [agent.name]: agent }));
            return agent;
         });

         const deleteAgent = Effect.fn("AgentsStore.deleteAgent")(function* (name: string, cwd?: string) {
            const res = deleteAgentFromDisk(name, cwd);
            if (res.success) {
               yield* Ref.update(agentsRef, (prev) => {
                  const copy = { ...prev };
                  delete copy[name];
                  return copy;
               });
            }
            return res;
         });

         const updateVibeProfile = Effect.fn("AgentsStore.updateVibeProfile")(function* (
            name: "fast" | "good",
            profile: VibeProfileConfig,
            cwd?: string
         ) {
            const definition = vibeProfileToDefinition(name, profile);
            saveAgentToDisk(definition, cwd);
            yield* Ref.update(agentsRef, (previous) => ({ ...previous, [name]: definition }));
            return profile;
         });

         return AgentsStore.of({
            getAgent,
            listAgents,
            getVibeProfiles,
            updateAgent,
            deleteAgent,
            updateVibeProfile
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: AgentsStoreShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | AgentsStore> {
      return Effect.gen(function* () {
         const svc = yield* AgentsStore;
         return yield* fn(svc);
      });
   }
}
