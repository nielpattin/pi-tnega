import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Thinking levels supported by Pi child sessions. */
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Profile source used by the profile editor and dashboard. */
export type AgentProfileSource = "builtin" | "global" | "project";

/** A named child-agent configuration exposed by the workflow DSL. */
export interface AgentProfile {
   /** Stable profile selector used in workflow scripts. */
   readonly name: string;
   /** Optional display name shown by the profile editor. */
   readonly display_name?: string;
   /** Human-readable profile description. */
   readonly description: string;
   /** Tools allowed in the child session. */
   readonly tools: ReadonlyArray<string>;
   /** Optional guidance retained in profile files. */
   readonly guidance?: string;
   /** Profile instructions appended to the child system prompt. */
   readonly systemPrompt: string;
   /** Compatibility alias used by the existing profile editor format. */
   readonly body?: string;
   /** Optional provider/model selector inherited by child sessions. */
   readonly model?: string;
   /** Optional thinking level inherited by child sessions. */
   readonly thinking?: AgentThinkingLevel;
   /** Whether the profile may be selected. */
   readonly enabled: boolean;
   /** Where the profile was loaded from. */
   readonly source: AgentProfileSource;
   /** Profile file path when loaded from disk. */
   readonly filePath?: string;
   /** Whether a disk file overrides a built-in profile. */
   readonly isOverride?: boolean;
   /** Compatibility metadata used by the editor. */
   readonly scope?: "project" | "global" | "both" | "builtin";
   readonly scopes?: ReadonlyArray<"project" | "global">;
}

export interface AgentProfileStorageOptions {
   /** Pi agent directory. Defaults to the active Pi agent directory. */
   readonly agentDir?: string;
   /** Project directory used for project-file cleanup. */
   readonly cwd?: string;
}

const FULL_TOOLS = ["read", "write", "edit", "bash", "grep", "find"] as const;
const READ_ONLY_TOOLS = ["read", "grep", "find"] as const;
const AGENT_THINKING_LEVELS = new Set<AgentThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isAgentThinkingLevel(value: unknown): value is AgentThinkingLevel {
   return typeof value === "string" && AGENT_THINKING_LEVELS.has(value as AgentThinkingLevel);
}

export function normalizeAgentThinkingLevel(value: unknown): AgentThinkingLevel {
   return isAgentThinkingLevel(value) ? value : "medium";
}

const FAST_AGENT_BODY = `# FAST AGENT

You are a focused delegated coding agent.

Complete only the assigned task, use the available tools efficiently, and return a concise, self-contained result.`;
const GOOD_AGENT_BODY = `# GOOD AGENT

You are a careful delegated coding agent.

Explore the relevant code, plan before editing, verify your work, and return a complete self-contained result.`;
const SCOUT_AGENT_BODY = `# SCOUT AGENT

You are a read-only codebase research agent.

Investigate the assigned scope, follow relevant dependencies, and return structured findings without modifying files.`;
const REVIEWER_AGENT_BODY = `# REVIEWER AGENT

You are a code review agent.

Inspect the assigned changes for correctness, regressions, missing edge cases, and architectural risks. Return actionable findings without modifying files.`;

function builtInProfile(
   name: string,
   description: string,
   tools: ReadonlyArray<string>,
   thinking: AgentThinkingLevel,
   body: string
): AgentProfile {
   return {
      name,
      description,
      tools,
      thinking,
      enabled: true,
      source: "builtin",
      systemPrompt: body,
      body,
      scope: "builtin",
      scopes: []
   } as AgentProfile & { readonly body: string };
}

const BUILTIN_PROFILES: ReadonlyArray<AgentProfile> = [
   builtInProfile(
      "fast",
      "Lightweight profile for quick research and small implementation work.",
      FULL_TOOLS,
      "low",
      FAST_AGENT_BODY
   ),
   builtInProfile(
      "good",
      "General-purpose profile for complex implementation work.",
      FULL_TOOLS,
      "high",
      GOOD_AGENT_BODY
   ),
   builtInProfile(
      "scout",
      "Read-only profile for rapid codebase research and analysis.",
      READ_ONLY_TOOLS,
      "low",
      SCOUT_AGENT_BODY
   ),
   builtInProfile(
      "reviewer",
      "Read-only profile for reviewing changes and identifying risks.",
      READ_ONLY_TOOLS,
      "high",
      REVIEWER_AGENT_BODY
   )
];

function profileBody(profile: AgentProfile): string {
   return profile.systemPrompt || profile.body || "";
}

/** Return the built-in profiles in stable display order. */
export function listBuiltInAgentProfiles(): ReadonlyArray<AgentProfile> {
   return BUILTIN_PROFILES;
}

function parseFrontmatter(text: string): { metadata: Map<string, string>; body: string } {
   if (!text.startsWith("---")) return { metadata: new Map(), body: text.trim() };
   const end = text.indexOf("\n---", 3);
   if (end < 0) return { metadata: new Map(), body: text.trim() };
   const metadata = new Map<string, string>();
   for (const line of text.slice(3, end).split("\n")) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line
         .slice(separator + 1)
         .trim()
         .replace(/^['"]|['"]$/g, "");
      if (key) metadata.set(key, value);
   }
   return { metadata, body: text.slice(end + 4).trim() };
}

function parseThinking(value: string | undefined): AgentThinkingLevel | undefined {
   return isAgentThinkingLevel(value) ? value : undefined;
}

function profileSourceFor(name: string, source: Exclude<AgentProfileSource, "builtin">): AgentProfileSource {
   return BUILTIN_PROFILES.some((profile) => profile.name === name) ? "builtin" : source;
}

function parseProfile(
   name: string,
   text: string,
   source: Exclude<AgentProfileSource, "builtin">,
   filePath: string
): AgentProfile | undefined {
   const parsed = parseFrontmatter(text);
   if (!parsed.body) return undefined;
   const tools = parsed.metadata
      .get("tools")
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
   const thinking = parseThinking(parsed.metadata.get("thinking"));
   const resolvedSource = profileSourceFor(name, source);
   return {
      name,
      display_name: parsed.metadata.get("display_name"),
      description: parsed.metadata.get("description") ?? `Custom ${name} profile.`,
      tools: tools && tools.length > 0 ? tools : [...FULL_TOOLS],
      ...(parsed.metadata.get("guidance") ? { guidance: parsed.metadata.get("guidance") } : {}),
      systemPrompt: parsed.body,
      body: parsed.body,
      ...(parsed.metadata.get("model") ? { model: parsed.metadata.get("model") } : {}),
      ...(thinking ? { thinking } : {}),
      enabled: parsed.metadata.get("enabled")?.toLowerCase() !== "false",
      source: resolvedSource,
      filePath,
      ...(resolvedSource === "builtin" ? { isOverride: true } : {}),
      scope: source,
      scopes: [source]
   };
}

export function parseAgentProfileMarkdown(
   name: string,
   text: string,
   filePath?: string,
   source: Exclude<AgentProfileSource, "builtin"> = filePath?.includes(".pi/agents") ? "project" : "global"
): AgentProfile | undefined {
   return parseProfile(name, text, source, filePath ?? "");
}

function loadProfileDirectory(directory: string, source: Exclude<AgentProfileSource, "builtin">): AgentProfile[] {
   if (!fs.existsSync(directory)) return [];
   let files: string[];
   try {
      files = fs.readdirSync(directory).filter((file) => file.endsWith(".md"));
   } catch {
      return [];
   }
   const profiles: AgentProfile[] = [];
   for (const file of files) {
      try {
         const filePath = path.join(directory, file);
         const name = path.basename(file, ".md");
         const profile = parseProfile(name, fs.readFileSync(filePath, "utf8"), source, filePath);
         if (profile) profiles.push(profile);
      } catch {
         // Optional profile files are isolated from workflow startup.
      }
   }
   return profiles;
}

/** Return the global profile directory. */
export function getGlobalAgentProfilesDir(agentDir = getAgentDir()): string {
   return path.join(agentDir, "agents");
}

/** Return both supported project profile directories. */
export function getProjectAgentProfilesDirs(cwd?: string): string[] {
   return cwd ? [path.join(cwd, "agents"), path.join(cwd, ".pi", "agents")] : [];
}

function mergeProfile(profile: AgentProfile, existing: AgentProfile | undefined): AgentProfile {
   if (!existing || !BUILTIN_PROFILES.some((builtin) => builtin.name === profile.name)) return profile;
   return {
      ...profile,
      source: "builtin",
      isOverride: true,
      scope: existing.scope === "builtin" ? profile.scope : "both",
      scopes: existing.scope === "builtin" ? profile.scopes : ["global", "project"]
   };
}

/** Load built-in and optional global/project profile files. */
export function listAgentProfiles(
   cwd?: string,
   options: { readonly agentDir?: string } = {}
): ReadonlyArray<AgentProfile> {
   const profiles = new Map(BUILTIN_PROFILES.map((profile) => [profile.name, profile]));
   const globalProfiles = loadProfileDirectory(getGlobalAgentProfilesDir(options.agentDir), "global");
   for (const profile of globalProfiles) profiles.set(profile.name, mergeProfile(profile, profiles.get(profile.name)));
   for (const directory of getProjectAgentProfilesDirs(cwd)) {
      for (const profile of loadProfileDirectory(directory, "project")) {
         profiles.set(profile.name, mergeProfile(profile, profiles.get(profile.name)));
      }
   }
   return [...profiles.values()];
}

/** Resolve a named profile, defaulting omitted selection to `good`. */
export function resolveAgentProfile(
   name: unknown,
   cwd?: string,
   options: { readonly agentDir?: string } = {}
): AgentProfile | undefined {
   const requested = typeof name === "string" && name.trim().length > 0 ? name.trim() : "good";
   return listAgentProfiles(cwd, options).find((profile) => profile.enabled && profile.name === requested);
}

/** Serialize one profile into the existing Pi agent Markdown format. */
export function serializeAgentProfile(profile: AgentProfile): string {
   const lines: string[] = ["---"];
   lines.push(`name: ${profile.name}`);
   lines.push(`description: ${profile.description || ""}`);
   if (profile.display_name) lines.push(`display_name: ${profile.display_name}`);
   if (profile.tools.length > 0) lines.push(`tools: ${profile.tools.join(", ")}`);
   if (profile.model) lines.push(`model: ${profile.model}`);
   if (profile.thinking) lines.push(`thinking: ${profile.thinking}`);
   if (profile.guidance) lines.push(`guidance: ${profile.guidance}`);
   lines.push(`enabled: ${profile.enabled ? "true" : "false"}`);
   lines.push("---", "", profileBody(profile) || `# ${profile.name.toUpperCase()} PROFILE`, "");
   return lines.join("\n");
}

/** Save a profile as a global Pi profile, matching the existing editor behavior. */
export function saveAgentProfile(profile: AgentProfile, options: AgentProfileStorageOptions = {}): string {
   const globalDir = getGlobalAgentProfilesDir(options.agentDir);
   fs.mkdirSync(globalDir, { recursive: true });
   const globalPath = path.join(globalDir, `${profile.name}.md`);
   fs.writeFileSync(globalPath, serializeAgentProfile(profile), "utf8");

   for (const directory of getProjectAgentProfilesDirs(options.cwd)) {
      const projectPath = path.join(directory, `${profile.name}.md`);
      if (path.resolve(projectPath) === path.resolve(globalPath)) continue;
      try {
         if (fs.existsSync(projectPath)) fs.unlinkSync(projectPath);
      } catch {
         // Global profile persistence remains successful if cleanup fails.
      }
   }
   return globalPath;
}

/** Delete a profile file from its known path, project paths, or global path. */
export function deleteAgentProfile(
   profileOrName: Pick<AgentProfile, "name" | "filePath"> | string,
   options: AgentProfileStorageOptions = {}
): { success: boolean; error?: string } {
   const name = typeof profileOrName === "string" ? profileOrName : profileOrName.name;
   const knownPath = typeof profileOrName === "string" ? undefined : profileOrName.filePath;
   const candidates = [
      ...(knownPath ? [knownPath] : []),
      ...getProjectAgentProfilesDirs(options.cwd).map((directory) => path.join(directory, `${name}.md`)),
      path.join(getGlobalAgentProfilesDir(options.agentDir), `${name}.md`)
   ];

   let deleted = false;
   for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
         fs.unlinkSync(candidate);
         deleted = true;
      } catch (error) {
         return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
   }
   return deleted ? { success: true } : { success: false, error: `Profile file for "${name}" not found.` };
}
