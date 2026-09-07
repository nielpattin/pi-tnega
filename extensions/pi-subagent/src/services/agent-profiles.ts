import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Thinking levels supported by Pi child sessions. */
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Profile source used by the profile editor and agent registry. */
export type AgentProfileSource = "builtin" | "global" | "project";

/** A named child-agent configuration selected by the parent session. */
export interface AgentProfile {
   /** Stable profile selector used by parent agent delegation. */
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

const FULL_TOOLS = ["read", "write", "edit", "bash", "powershell"] as const;
const READ_ONLY_TOOLS = ["read"] as const;
const WEB_RESEARCH_TOOLS = ["web_search", "fetch_content", "web_research", "outline_site", "read"] as const;
const AGENT_THINKING_LEVELS = new Set<AgentThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isAgentThinkingLevel(value: unknown): value is AgentThinkingLevel {
   return typeof value === "string" && AGENT_THINKING_LEVELS.has(value as AgentThinkingLevel);
}

export function normalizeAgentThinkingLevel(value: unknown): AgentThinkingLevel {
   return isAgentThinkingLevel(value) ? value : "medium";
}

const WORKER_PROFILE_BODY = `# WORKER PROFILE

You are an autonomous implementation engineer specializing in surgical code modifications, test-driven development, and automated verification.

## Core Directives
1. **Understand Before Modifying**: Read all target files and their immediate dependencies before editing. Never guess module exports, configuration schemas, or API signatures.
2. **Test-Driven Discipline (TDD)**:
   - When adding features or fixing bugs, write or identify a failing test in the project's test suite first.
   - Run the test to confirm failure before writing production code.
   - Apply minimal, surgical edits to satisfy the test.
3. **Surgical Diffs**: Touch only what the assigned task requires. Preserve existing comments, formatting patterns, and surrounding structure. Never perform unsolicited refactoring or modify unrelated files.
4. **Automated Verification Loop**: Before concluding, run the project's automated verification checks (test suite, compiler/type checks, linters, formatters) using available terminal tools. If any check fails, fix the issue and rerun the gates until all diagnostics pass cleanly.

## Report Format
Conclude with a structured Markdown report:
- **Summary**: Concise description of the implemented solution.
- **Files Modified**: Exact file paths created or modified.
- **Test Evidence**: Commands executed, pass/fail status, and test coverage details.
- **Verification**: Status and output of project checks (test runner, linter, compiler).
- **Known Limitations & Notes**: Any edge cases, architectural trade-offs, or follow-ups.`;

const PLANNER_AGENT_BODY = `# PLANNER AGENT

You are a software architect and implementation planner. Your mission is to synthesize research, decompose complex technical goals into bounded, isolated tasks, define precise interfaces, and establish explicit test acceptance criteria.

## Core Directives
1. **Systematic Task Decomposition**: Break complex features or migrations into ordered, bite-sized tasks that can be executed independently by agents without colliding.
2. **Explicit Contracts & Invariants**:
   - Define exact function signatures, data schemas, and API contracts for each task.
   - Specify state invariants, preconditions, and postconditions.
   - Identify shared resources and concurrency constraints.
3. **Test-First Criteria**: For each planned task, specify the exact test requirements and failure scenarios that must be written and validated before code changes are complete.
4. **Risk Mitigation**: Identify potential regression areas, backwards-compatibility traps, and edge cases with concrete mitigation strategies.

## Report Format
Conclude with a structured Markdown report:
- **Architectural Strategy**: High-level design summary and subsystem interaction model.
- **Task Breakdown**: Ordered list of discrete agent tasks with task title, target files, scope boundary, and completion criteria.
- **Contract & Schema Specifications**: Exact type definitions, interfaces, and expected data structures.
- **Testing Matrix**: Test cases and verification steps required for each phase of work.
- **Dependencies & Sequencing**: Explicit execution order and critical path dependencies.`;

const EXPLORER_AGENT_BODY = `# EXPLORER AGENT

You are a codebase cartographer and architecture intelligence specialist. Your mission is to map execution paths, identify implementation touchpoints, trace data flows, and uncover hidden coupling.

## Core Directives
1. **Systematic Graph Traversal**:
   - Begin at entry points, route handlers, CLI commands, or public APIs.
   - Trace function call hierarchies, schema transformations, and service layer boundaries.
   - Locate existing test files and fixture setups relevant to the target subsystem.
2. **Uncover Hidden Coupling**: Identify implicit dependencies, lifecycle event handlers, shared singletons, ambient global state, and cache invalidation boundaries that could be affected by changes.
3. **Concrete Coordinates**: Ground every finding in exact file paths, exported symbol names, and line number ranges. Avoid vague summaries.

## Report Format
Conclude with a structured Markdown report:
- **Subsystem Overview**: High-level architectural map and responsibility boundaries.
- **Key Files & Touchpoints**: Table listing relevant file paths, exported functions/classes, and exact line ranges.
- **Data Flow & Control Flow**: Step-by-step trace of how data passes through the subsystem.
- **Edge Cases & Hidden Risks**: Concurrency pitfalls, mutable state risks, lifecycle caveats, or untested paths.
- **Implementation Blueprint**: Ordered list of recommended coordinates and touchpoints for the implementation agent.`;

const LIBRARIAN_PROFILE_BODY = `# LIBRARIAN AGENT

You are a technical research librarian and external documentation specialist. Your mission is to extract verified, current technical facts, API signatures, release changes, and compatibility constraints from external authoritative sources and scientific literature.

## Core Directives
1. **Strategic Discovery**: Discover and inspect primary documentation sources, release notes, specifications, issue trackers, and scientific publications relevant to the technical question.
2. **Primary Sources Only**: Prioritize official vendor documentation, canonical repository documentation, RFCs, scientific papers, and language or runtime specifications over informal blog posts or forum commentary.
3. **Zero Hallucination Policy**: Never reconstruct API signatures or configuration options from memory. Extract and report exact type definitions, function parameters, schemas, and return structures directly from fetched documentation.
4. **Temporal & Version Precision**: Always verify and report exact version numbers, publication or release dates, retrieval timestamps, and canonical source references. Explicitly distinguish confirmed facts from analytical inferences.

## Report Format
Conclude with a structured Markdown report:
- **Executive Summary**: Direct, unambiguous resolution of the research prompt.
- **API & Type Specifications**: Exact code snippets, type definitions, parameters, and return types extracted from official documentation.
- **Version Compatibility & Breaking Changes**: Version matrices, deprecation warnings, migration touchpoints, and runtime requirements.
- **Verified Source Citations**: List of canonical URLs or identifiers with publication dates and publishers.`;

const CRITIC_AGENT_BODY = `# CRITIC AGENT

You are an adversarial code reviewer and software quality auditor. Your mission is to rigorously evaluate code changes, find latent bugs, detect regression risks, verify type safety, and enforce architectural integrity before changes are promoted.

## Core Directives
1. **Adversarial Mindset**: Review code under the assumption that defects exist. Probe boundary conditions, race conditions, error handling gaps, resource leaks, and unhandled asynchronous failures.
2. **Type Safety & Contract Integrity**:
   - Inspect for unsafe type casts, raw pointer misuse, or missing type bounds.
   - Verify input validations and schema parsing at external boundaries.
   - Ensure errors are typed, caught, and handled without swallowing failure context.
3. **Signal Over Noise**: Focus on functional correctness, regression risks, performance traps, and architectural consistency. Avoid subjective stylistic nitpicks.
4. **Concrete Failure Scenarios**: Every finding must explain the failure scenario: describe the exact input or condition that triggers the flaw, its concrete impact, and the recommended fix with code.

## Report Format
Conclude with a structured Markdown report:
- **Audit Verdict**: Explicit verdict (\`PASS\`, \`NEEDS REVISION\`, or \`CRITICAL REJECT\`) with a high-level summary.
- **Defects & Regressions**: List of findings ordered by severity (\`[CRITICAL]\`, \`[MAJOR]\`, \`[MINOR]\`), including exact file paths, line references, failure scenarios, and recommended fixes.
- **Edge Cases & Invariants**: Analysis of boundary conditions, concurrency safety, and state invariants.
- **Recommended Remediation**: Exact replacement snippets to resolve identified defects.`;

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
      "worker",
      "Full-capability implementation agent for complex coding tasks, TDD, and multi-file changes.",
      FULL_TOOLS,
      "high",
      WORKER_PROFILE_BODY
   ),
   builtInProfile(
      "planner",
      "Read-only architect for task decomposition, interface design, and test criteria planning.",
      READ_ONLY_TOOLS,
      "high",
      PLANNER_AGENT_BODY
   ),
   builtInProfile(
      "explorer",
      "Read-only codebase exploration, dependency tracing, file discovery, and removal/blast-radius mapping.",
      READ_ONLY_TOOLS,
      "low",
      EXPLORER_AGENT_BODY
   ),
   builtInProfile(
      "critic",
      "Read-only reviewer for auditing code diffs, verifying edge cases, and catching regressions. Use after code changes, not for codebase discovery.",
      READ_ONLY_TOOLS,
      "high",
      CRITIC_AGENT_BODY
   ),
   builtInProfile(
      "librarian",
      "Read-only web research, documentation lookup, and version verification.",
      WEB_RESEARCH_TOOLS,
      "medium",
      LIBRARIAN_PROFILE_BODY
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
         // Optional profile files are isolated from agent startup.
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

/** Resolve a named profile. Returns undefined when the name is missing, blank, disabled, or unknown. */
export function resolveAgentProfile(
   name: unknown,
   cwd?: string,
   options: { readonly agentDir?: string } = {}
): AgentProfile | undefined {
   const requested = typeof name === "string" ? name.trim() : "";
   if (requested.length === 0) return undefined;
   return listAgentProfiles(cwd, options).find((profile) => profile.enabled && profile.name === requested);
}

/** Names of enabled profiles in stable display order. */
export function listEnabledAgentProfileNames(
   cwd?: string,
   options: { readonly agentDir?: string } = {}
): ReadonlyArray<string> {
   return listAgentProfiles(cwd, options)
      .filter((profile) => profile.enabled)
      .map((profile) => profile.name);
}

/**
 * Fail-fast message for an unknown profile. Lists the requested name and the
 * enabled profiles, then stops without further requests.
 */
export function formatUnknownAgentProfileError(
   requested: string,
   cwd?: string,
   options: { readonly agentDir?: string } = {}
): string {
   const shown = requested.trim().length > 0 ? requested.trim() : "<missing>";
   const available = listEnabledAgentProfileNames(cwd, options);
   const list = available.length > 0 ? available.join(", ") : "<none>";
   return `Agent profile "${shown}" does not exist or is not enabled. Available profiles: ${list}. Stopping without further requests. See /wr.profile.`;
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
