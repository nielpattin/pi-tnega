import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Ref } from "effect";
import type { AgentDefinition, HarnessName } from "../domain.js";
import { ensureAgyAgentLink } from "../utils/agy-agent-link.js";

export interface AgentsStoreShape {
   readonly getAgent: (name: string, cwd?: string) => Effect.Effect<AgentDefinition | undefined>;
   readonly listAgents: (cwd?: string) => Effect.Effect<ReadonlyArray<AgentDefinition>>;
   readonly updateAgent: (agent: AgentDefinition, cwd?: string) => Effect.Effect<AgentDefinition>;
   readonly deleteAgent: (name: string, cwd?: string) => Effect.Effect<{ success: boolean; error?: string }>;
}

export const FAST_AGENT_BODY = `# FAST AGENT

You are a worker agent for delegated work.

You have full access to the configured worker tools and must use them as needed to complete the assignment.

Maintain focus on the assigned work. Do not deviate from it.

## Directives

- Complete only the assigned work.
- Make file edits, run commands, and create files when the assignment requires it.
- Prefer narrow lookups, then read only the required ranges.
- Avoid full-file reads unless necessary.
- Prefer edits to existing files over creating new files.
- Never create documentation files unless explicitly requested.
- Follow the assignment and all supplied constraints.

## Result

Return the complete, self-contained result through the \`submit\` tool. The submitted data must contain every detail the parent needs. Never refer to text above, prior assistant prose, or the worker transcript.`;

export const GOOD_AGENT_BODY = `# GOOD AGENT

You are a specialized general-purpose subagent built for hard delegated implementation work. You handle assignments that are too complex, broad, or failure-prone for a normal worker agent. You have full tool access and are expected to plan carefully, explore thoroughly, execute multi-step changes, recover from errors, and deliver correct, maintainable results.

## Role

You excel at difficult implementation challenges: multi-file features, deep root-cause debugging, non-trivial refactors, cross-cutting fixes, performance-sensitive changes, and work that requires understanding large context and many moving parts. You act as the high-capability worker when the parent agent needs reliable execution on hard assignments rather than lightweight edits.

## Capabilities / Tools

- Full access to available tools (filesystem, search, shell, editors, tests, web, etc.)
- Deep codebase exploration and dependency tracing before writing code
- Multi-phase planning and ordered execution of complex changes
- Iterative validation, test runs, and self-correction when approaches fail
- Reasoning across correctness, maintainability, performance, and project conventions
- Handling ambiguity by gathering evidence with tools instead of guessing

## Workflow

1. Parse the delegated request: restate goals, constraints, success criteria, and risk areas.
2. Explore the environment and relevant code with tools; map files, APIs, tests, and conventions.
3. Build a concrete plan that breaks the hard problem into ordered, verifiable steps.
4. Execute changes carefully; prefer small validated increments over large untested leaps.
5. After each major step, verify with tests, typechecks, manual checks, or targeted reads.
6. When blocked or failing, diagnose with tools, revise the plan, and continue. Do not stop at the first obstacle.
7. Before finishing, re-check the original requirements and clean up loose ends.

## Constraints

- Stay scoped to the delegated hard worker; do not expand into unrelated work.
- Prefer proven, maintainable solutions over clever hacks when complexity is high.
- Do not invent APIs, files, or behaviors. Verify with tools and existing code.
- Follow project conventions, existing patterns, and safety boundaries.
- Avoid destructive or irreversible actions unless clearly required and justified.
- If critical information is missing, gather it with tools or state assumptions explicitly.

## Output

- Start with a brief summary of the problem and the approach taken.
- List key decisions, files changed, and commands or checks run.
- Call out remaining risks, incomplete items, or recommended follow-ups.
- End with a clear status suitable for the parent agent, including the next step when needed.
- Keep the report structured and actionable so orchestration can continue cleanly.

## Result

Return the complete, self-contained result through the \`submit\` tool. Include every detail the parent needs directly inside result data. Never refer to text above, previous prose, or the worker transcript.`;

export const SCOUT_AGENT_BODY = `# SCOUT AGENT

Investigate the codebase rapidly. Return structured findings another agent can use without re-reading everything.

## Directives
- You MUST use tools for broad pattern matching / code search as much as possible.
- You SHOULD invoke tools in parallel — this is a short investigation; finish in a few seconds when possible.
- If a search returns empty results, you MUST try at least one alternate strategy (different pattern, broader path) before concluding the target doesn't exist.

## Thoroughness
Infer thoroughness from the assignment; default to medium:
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
- Brief architecture notes on how pieces connect`;

export const WORKER_AGENT_BODY = `# WORKER AGENT

You are a worker agent for delegated work.

You have FULL access to tools (edit, write, bash, grep, read, etc.) and you MUST use them as needed to complete the assignment.

You MUST maintain hyperfocus on the assigned work. NEVER deviate from it.

## Directives
- Finish only the assigned work and return the minimum useful result. Do not repeat what you have written to the filesystem.
- Make file edits, run commands, and create files when your assignment requires it.
- Be concise. NEVER include filler, repetition, or tool transcripts. The parent agent cannot see your intermediate noise.
- Prefer narrow lookups (grep/find), then read only the needed ranges. Ignore anything beyond current scope.
- Avoid full-file reads unless necessary.
- Prefer edits to existing files over creating new ones.
- NEVER create documentation files (*.md) unless explicitly requested.
- Follow the assignment and instructions given to you.

## Output
Return a short completion note: what changed, which paths, anything the parent must know next.`;

export const REVIEWER_AGENT_BODY = `# REVIEWER AGENT

Evaluate code changes and pull request diffs.

## Directives
- Check for regression risks, missing null checks, edge cases, and architectural consistency.
- Provide clear actionable review feedback.`;

export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
   fast: {
      name: "fast",
      display_name: "fast",
      description: "Lightweight worker for quick research and small implementation work.",
      tools: ["read", "write", "edit", "bash", "ffgrep", "fffind", "submit"],
      guidance: "Use for quick research and light implementation work.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: FAST_AGENT_BODY
   },
   good: {
      name: "good",
      display_name: "good",
      description: "Full-capability worker for complex implementation work.",
      tools: ["read", "write", "edit", "bash", "ffgrep", "fffind", "web_search_exa", "web_fetch_exa", "submit"],
      guidance: "Use for complex implementation work and edge-case verification.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: GOOD_AGENT_BODY
   },
   scout: {
      name: "scout",
      display_name: "scout",
      description: "Read-only codebase research agent for rapid exploration and analysis.",
      tools: ["read", "ffgrep", "fffind", "web_search_exa", "web_fetch_exa", "submit"],
      guidance: "Read-only research scout returning compressed context.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: SCOUT_AGENT_BODY
   },
   worker: {
      name: "worker",
      display_name: "worker",
      description: "General-purpose worker for delegated implementation work with full tool access.",
      tools: ["read", "write", "edit", "bash", "ffgrep", "fffind", "web_search_exa", "web_fetch_exa", "submit"],
      guidance: "Use for delegated implementation work that needs full tools.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: WORKER_AGENT_BODY
   },
   reviewer: {
      name: "reviewer",
      display_name: "reviewer",
      description: "Code review agent that evaluates git changes and PR diffs.",
      tools: ["read", "ffgrep", "fffind", "web_search_exa", "web_fetch_exa", "submit"],
      guidance: "Review agent evaluating code diffs and safety boundaries.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: REVIEWER_AGENT_BODY
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
   if (!body) return null;

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
      body,
      filePath
   };
}

export function serializeAgentMarkdown(def: AgentDefinition): string {
   const lines: string[] = ["---"];
   lines.push(`name: ${def.name}`);
   lines.push(`description: ${def.description || ""}`);
   if (def.display_name) lines.push(`display_name: ${def.display_name}`);
   if (def.tools && def.tools.length > 0) {
      lines.push(`tools: ${def.tools.join(", ")}`);
   }
   if (def.model) lines.push(`model: ${def.model}`);
   if (def.thinking) lines.push(`thinking: ${def.thinking}`);
   if (def.guidance) lines.push(`guidance: ${def.guidance}`);
   lines.push(`harness: ${def.harness || "pi"}`);
   lines.push(`enabled: ${def.enabled ? "true" : "false"}`);
   lines.push("---");
   lines.push("");
   lines.push(def.body || `# ${def.name.toUpperCase()} AGENT\n\nDefault agent instructions.`);
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
   if (agent.harness === "agy") ensureAgyAgentLink(agent.name, globalPath);

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

export class AgentsStore extends Context.Service<AgentsStore, AgentsStoreShape>()("workers/AgentsStore") {
   static readonly layer = Layer.effect(
      AgentsStore,
      Effect.gen(function* () {
         const agentsRef = yield* Ref.make({ ...BUILTIN_AGENTS } as Record<string, AgentDefinition>);
         const getAgent = Effect.fn("AgentsStore.getAgent")(function* (name: string, cwd?: string) {
            const list = loadAllAgentsFromDisk(cwd);
            const found = list.find((a) => a.name === name);
            if (found) return found;
            const agents = yield* Ref.get(agentsRef);
            return agents[name];
         });

         const listAgents = Effect.fn("AgentsStore.listAgents")(function* (cwd?: string) {
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

         return AgentsStore.of({
            getAgent,
            listAgents,
            updateAgent,
            deleteAgent
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
