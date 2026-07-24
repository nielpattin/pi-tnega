import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BackendName, ReasoningEffort } from "../domain.ts";

export interface AgentDefinition {
   name: string;
   description: string;
   display_name?: string;
   tools?: string[];
   model?: string;
   thinking?: ReasoningEffort;
   guidance?: string;
   harness: BackendName;
   enabled: boolean;
   body: string;
   filePath?: string;
   source?: "builtin" | "user";
}

export interface PiProfileConfig {
   model: string | null;
   reasoning_effort: ReasoningEffort | null;
   tools?: string[];
   body?: string;
}

export interface AgyProfileConfig {
   model: string;
   reasoning_effort: "low" | "medium" | "high";
   body?: string;
}

export interface AgentProfile {
   harness: BackendName;
   pi: PiProfileConfig;
   agy: AgyProfileConfig;
   tools?: string[];
   body?: string;
}

export interface AgentsConfig {
   version: 1;
   profiles: {
      fast: AgentProfile;
      good: AgentProfile;
   };
}

export type ProfileName = "fast" | "good";

export interface ParseAgentResult {
   definition?: AgentDefinition;
   error?: string;
}

function parseYamlFrontmatter(fmText: string): Record<string, string> {
   const result: Record<string, string> = {};
   const lines = fmText.split("\n");
   for (const line of lines) {
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

export function parseAgentMarkdown(name: string, content: string, filePath?: string): ParseAgentResult {
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
   if (!body) {
      return {
         error: `Agent "${name}" has no system prompt body. Edit it in /agents and add instructions under the frontmatter.`
      };
   }

   const kv = parseYamlFrontmatter(fmText);

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
   const thinking = (kv.thinking || undefined) as ReasoningEffort | undefined;
   const guidance = kv.guidance || undefined;
   const harness: BackendName = kv.harness === "agy" ? "agy" : "pi";
   const enabled = kv.enabled !== undefined ? kv.enabled.toLowerCase() === "true" : true;

   return {
      definition: {
         name,
         description,
         display_name,
         tools,
         model,
         thinking,
         guidance,
         harness,
         enabled,
         body,
         filePath
      }
   };
}

export function serializeAgentMarkdown(def: AgentDefinition): string {
   const lines: string[] = ["---"];
   lines.push(`description: ${def.description || ""}`);
   if (def.display_name) lines.push(`display_name: ${def.display_name}`);
   if (def.tools !== undefined) {
      lines.push(`tools: ${def.tools.join(", ")}`);
   }
   if (def.model) lines.push(`model: ${def.model}`);
   if (def.thinking) lines.push(`thinking: ${def.thinking}`);
   if (def.guidance) lines.push(`guidance: ${def.guidance}`);
   lines.push(`harness: ${def.harness}`);
   lines.push(`enabled: ${def.enabled ? "true" : "false"}`);
   lines.push("---");
   lines.push("");
   lines.push(def.body);
   lines.push("");
   return lines.join("\n");
}

export function getGlobalAgentsDir(): string {
   return path.join(getAgentDir(), "agents");
}

export function getProjectAgentsDir(cwd: string): string {
   return path.join(cwd, ".pi", "agents");
}

import { BUILTIN_AGENTS, isBuiltinAgentName } from "./builtins.ts";

export function mergeAgents(builtins: AgentDefinition[], fileAgents: AgentDefinition[]): AgentDefinition[] {
   const result = new Map<string, AgentDefinition>();

   for (const b of builtins) {
      result.set(b.name, { ...b, source: "builtin" });
   }

   for (const f of fileAgents) {
      const isBuiltin = isBuiltinAgentName(f.name);
      result.set(f.name, {
         ...f,
         source: isBuiltin ? "builtin" : "user"
      });
   }

   return Array.from(result.values());
}

export function loadAllAgents(cwd?: string): Map<string, AgentDefinition> {
   const fileAgents: AgentDefinition[] = [];

   // Global dir
   const globalDir = getGlobalAgentsDir();
   if (fs.existsSync(globalDir)) {
      try {
         const files = fs.readdirSync(globalDir);
         for (const file of files) {
            if (file.endsWith(".md")) {
               const name = path.basename(file, ".md");
               const filePath = path.join(globalDir, file);
               try {
                  const content = fs.readFileSync(filePath, "utf-8");
                  const parsed = parseAgentMarkdown(name, content, filePath);
                  if (parsed.definition) {
                     fileAgents.push(parsed.definition);
                  }
               } catch {
                  // ignore invalid files
               }
            }
         }
      } catch {
         // ignore dir errors
      }
   }

   // Project dir overrides global if provided
   if (cwd) {
      const projDir = getProjectAgentsDir(cwd);
      if (fs.existsSync(projDir)) {
         try {
            const files = fs.readdirSync(projDir);
            for (const file of files) {
               if (file.endsWith(".md")) {
                  const name = path.basename(file, ".md");
                  const filePath = path.join(projDir, file);
                  try {
                     const content = fs.readFileSync(filePath, "utf-8");
                     const parsed = parseAgentMarkdown(name, content, filePath);
                     if (parsed.definition) {
                        // Override global if same name
                        const idx = fileAgents.findIndex((a) => a.name === name);
                        if (idx !== -1) {
                           fileAgents[idx] = parsed.definition;
                        } else {
                           fileAgents.push(parsed.definition);
                        }
                     }
                  } catch {
                     // ignore
                  }
               }
            }
         } catch {
            // ignore
         }
      }
   }

   const merged = mergeAgents(BUILTIN_AGENTS, fileAgents);
   const map = new Map<string, AgentDefinition>();
   for (const agent of merged) {
      map.set(agent.name, agent);
   }
   return map;
}

export function loadAgent(name: string, cwd?: string): { definition?: AgentDefinition; error?: string } {
   const all = loadAllAgents(cwd);
   const found = all.get(name);
   if (found) {
      return { definition: found };
   }
   return { error: `Agent "${name}" not found.` };
}

export function saveAgent(def: AgentDefinition, targetDir?: string): string {
   const dir = targetDir || getGlobalAgentsDir();
   if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
   }
   const filePath = path.join(dir, `${def.name}.md`);
   const content = serializeAgentMarkdown(def);
   fs.writeFileSync(filePath, content, "utf-8");
   def.filePath = filePath;
   return filePath;
}

export function deleteAgent(name: string, cwd?: string): { success: boolean; error?: string } {
   if (isBuiltinAgentName(name)) {
      return {
         success: false,
         error: "Built-in agents cannot be deleted. Toggle enabled or edit/save to override."
      };
   }

   let deletedAny = false;

   if (cwd) {
      const projPath = path.join(getProjectAgentsDir(cwd), `${name}.md`);
      if (fs.existsSync(projPath)) {
         try {
            fs.unlinkSync(projPath);
            deletedAny = true;
         } catch (e: any) {
            return { success: false, error: e.message || String(e) };
         }
      }
   }

   if (!deletedAny) {
      const globalPath = path.join(getGlobalAgentsDir(), `${name}.md`);
      if (fs.existsSync(globalPath)) {
         try {
            fs.unlinkSync(globalPath);
            deletedAny = true;
         } catch (e: any) {
            return { success: false, error: e.message || String(e) };
         }
      }
   }

   if (!deletedAny) {
      return { success: false, error: `Agent file for "${name}" not found.` };
   }

   return { success: true };
}
