import { extractText, parseMessages, stableJson, type ParsedBlock } from "./messages";

/** Bounded compaction section names. */
export type CompactionSectionName =
   | "Goal"
   | "Constraints and Preferences"
   | "Files and Changes"
   | "Decisions and Progress"
   | "Errors and Blockers"
   | "Next Actions"
   | "Chronological Brief"
   | "Recent Verbatim Tail";

/** File facts supplied by Pi's compaction preparation when available. */
export interface CompactionFileOps {
   readonly readFiles?: readonly string[];
   readonly modifiedFiles?: readonly string[];
   readonly createdFiles?: readonly string[];
}

/** Limits for deterministic compaction output. */
export interface CompactionLimits {
   readonly maxChars?: number;
   readonly maxItemsPerSection?: number;
   readonly maxBriefLines?: number;
   readonly maxRecentTailChars?: number;
}

/** Input to the pure compaction compiler. */
export interface CompactionInput {
   readonly messagesToSummarize: readonly unknown[];
   readonly recentTail?: readonly unknown[];
   readonly previousSummary?: string;
   readonly fileOps?: CompactionFileOps;
   readonly limits?: CompactionLimits;
}

/** The structured deterministic compaction result. */
export interface CompactionOutput {
   readonly summary: string;
   readonly sections: readonly CompactionSectionName[];
   readonly estimatedTokens: number;
}

/** A value-or-error result for compaction input parsing. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** A concise compaction parse error. */
export interface CompactionError {
   readonly _tag: "CompactionError";
   readonly message: string;
}

interface SectionMap {
   goal: string[];
   constraints: string[];
   files: string[];
   decisions: string[];
   errors: string[];
   next: string[];
   brief: string[];
   recent: string[];
}

const DEFAULT_LIMITS: Required<CompactionLimits> = {
   maxChars: 12_000,
   maxItemsPerSection: 12,
   maxBriefLines: 80,
   maxRecentTailChars: 4_000
};
const ERROR_RE =
   /\b(?:error|failed|failure|warning|fatal|panic|exception|traceback|enoent|econnrefused|blocked|cannot|can't|crash)\b|npm ERR!/i;
const PREFERENCE_RE =
   /\b(?:prefer|preferred|must|never|do not|don't|avoid|keep|always|require|requirement|constraint)\b/i;
const PROGRESS_RE = /\b(?:decided|chose|selected|implemented|completed|done|fixed|progress|verified|tested|working)\b/i;
const NEXT_RE = /\b(?:next|todo|to do|remaining|follow[- ]?up|run the tests|verify|fix|check|needs to)\b/i;
const PATH_KEYS = ["path", "file_path", "filePath", "file"];

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanLine(value: string, maxChars = 260): string {
   const line = value.trim();
   if (line.length <= maxChars) return line;
   return `${line.slice(0, Math.max(1, maxChars - 1))}…`;
}

function sourced(block: ParsedBlock, value: string): string {
   return `[${block.id}] ${value}`;
}

function addUnique(target: string[], values: readonly string[], cap: number): void {
   const seen = new Set(target.map((value) => value.toLowerCase()));
   for (const raw of values) {
      const value = cleanLine(raw);
      if (!value || seen.has(value.toLowerCase())) continue;
      target.push(value);
      seen.add(value.toLowerCase());
      if (target.length >= cap) break;
   }
}

function clauses(text: string): string[] {
   return text
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+/))
      .map((line) => line.replace(/^[-*+\d.)\s]+/, "").trim())
      .filter(Boolean);
}

function messageText(message: Record<string, unknown>): string {
   const text = extractText(message.content);
   if (text) return text;
   if (typeof message.output === "string") return message.output;
   if (typeof message.summary === "string") return message.summary;
   return "";
}

function messageRole(message: Record<string, unknown>): string {
   return typeof message.role === "string" ? message.role : "other";
}

function extractPath(args: Record<string, unknown>): string | undefined {
   for (const key of PATH_KEYS) {
      if (typeof args[key] === "string" && args[key].trim()) return args[key];
   }
   return undefined;
}

function callDescription(block: ParsedBlock): string {
   const args = block.arguments ?? {};
   const path = extractPath(args);
   if (path) return `${block.toolName ?? "tool"} ${path}`;
   return `${block.toolName ?? "tool"} ${cleanLine(stableJson(args), 180)}`;
}

function parsePreviousSummary(summary: string | undefined): SectionMap {
   const result: SectionMap = {
      goal: [],
      constraints: [],
      files: [],
      decisions: [],
      errors: [],
      next: [],
      brief: [],
      recent: []
   };
   if (!summary?.trim()) return result;
   const aliases: Record<string, keyof SectionMap> = {
      goal: "goal",
      "constraints and preferences": "constraints",
      "constraints & preferences": "constraints",
      "files and changes": "files",
      "files touched": "files",
      "decisions and progress": "decisions",
      progress: "decisions",
      done: "decisions",
      "in progress": "decisions",
      blocked: "errors",
      "key decisions": "decisions",
      "errors and blockers": "errors",
      "next actions": "next",
      "next steps": "next",
      "chronological brief": "brief",
      "recent verbatim tail": "recent"
   };
   const lines = summary.split("\n");
   let current: keyof SectionMap | undefined;
   for (const line of lines) {
      const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
      if (heading) {
         current = aliases[heading[1].toLowerCase()];
         continue;
      }
      if (!current) continue;
      const item = /^\s*(?:[-*]\s+|\d+[.)]\s+)?(.+?)\s*$/.exec(line);
      if (item?.[1]) result[current].push(cleanLine(item[1]));
   }
   return result;
}

function buildSections(input: CompactionInput, limits: Required<CompactionLimits>): SectionMap {
   const parsed = parseMessages(input.messagesToSummarize);
   const sections: SectionMap = parsePreviousSummary(input.previousSummary);
   const cap = limits.maxItemsPerSection;
   if (!parsed.ok) return sections;

   const userBlocks = parsed.value.blocks.filter((block) => block.kind === "user");
   for (const block of userBlocks) {
      const userClauses = clauses(block.text);
      addUnique(
         sections.goal,
         userClauses.slice(0, 3).map((line) => sourced(block, line)),
         cap
      );
      addUnique(
         sections.constraints,
         userClauses.filter((line) => PREFERENCE_RE.test(line)).map((line) => sourced(block, line)),
         cap
      );
   }

   const fileCategories = new Map<string, string[]>();
   const addFile = (category: string, path: string): void => {
      const list = fileCategories.get(category) ?? [];
      if (!list.includes(path)) list.push(path);
      fileCategories.set(category, list);
   };
   for (const path of input.fileOps?.readFiles ?? []) addFile("Read", path);
   for (const path of input.fileOps?.modifiedFiles ?? []) addFile("Modified", path);
   for (const path of input.fileOps?.createdFiles ?? []) addFile("Created", path);
   for (const block of parsed.value.blocks) {
      if (block.kind !== "tool_call") continue;
      const path = block.arguments ? extractPath(block.arguments) : undefined;
      if (!path) continue;
      const tool = (block.toolName ?? "").toLowerCase();
      addFile(
         tool === "write" || tool === "write_file"
            ? "Created"
            : tool === "edit" || tool === "edit_file" || tool === "apply_patch"
              ? "Modified"
              : "Read",
         path
      );
   }
   for (const [category, paths] of fileCategories) {
      addUnique(sections.files, [`${category}: ${paths.join(", ")}`], cap);
   }

   for (const block of parsed.value.blocks) {
      if (block.kind === "user") {
         const lines = clauses(block.text);
         addUnique(
            sections.brief,
            lines.map((line) => sourced(block, `[user] ${line}`)),
            limits.maxBriefLines
         );
         addUnique(
            sections.next,
            lines.filter((line) => NEXT_RE.test(line)).map((line) => sourced(block, line)),
            cap
         );
      }
      if (block.kind === "tool_call")
         addUnique(
            sections.brief,
            [sourced(block, `[assistant tool] ${callDescription(block)}`)],
            limits.maxBriefLines
         );
      if (block.kind === "assistant_text") {
         const lines = clauses(block.text);
         addUnique(
            sections.goal,
            lines.filter((line) => /^goal\s*:/i.test(line)).map((line) => sourced(block, line)),
            cap
         );
         addUnique(
            sections.decisions,
            lines.filter((line) => PROGRESS_RE.test(line)).map((line) => sourced(block, line)),
            cap
         );
         addUnique(
            sections.next,
            lines.filter((line) => NEXT_RE.test(line)).map((line) => sourced(block, line)),
            cap
         );
         addUnique(
            sections.errors,
            lines.filter((line) => ERROR_RE.test(line)).map((line) => sourced(block, line)),
            cap
         );
         addUnique(
            sections.brief,
            lines.map((line) => sourced(block, `[assistant] ${line}`)),
            limits.maxBriefLines
         );
      }
      if (block.kind === "tool_result") {
         if (block.isError)
            addUnique(
               sections.errors,
               (clauses(block.text).length > 0 ? clauses(block.text) : [block.text]).map((line) =>
                  sourced(block, line)
               ),
               cap
            );
         else if (block.text)
            addUnique(
               sections.brief,
               [sourced(block, `[tool result ${block.toolName ?? "tool"}] ${cleanLine(block.text, 220)}`)],
               limits.maxBriefLines
            );
         addUnique(
            sections.errors,
            clauses(block.text)
               .filter((line) => ERROR_RE.test(line))
               .map((line) => sourced(block, line)),
            cap
         );
      }
   }
   if (sections.next.length === 0 && sections.decisions.length > 0) {
      addUnique(
         sections.next,
         sections.decisions.filter((line) => NEXT_RE.test(line)),
         cap
      );
   }

   const recentLines: string[] = [];
   for (const value of input.recentTail ?? []) {
      if (!isRecord(value)) continue;
      const role = messageRole(value);
      const text = messageText(value);
      if (!text && role !== "toolResult") continue;
      recentLines.push(`[${role}] ${text}`);
   }
   if (recentLines.length > 0) sections.recent = [recentLines.join("\n")];
   return sections;
}

function section(title: string, values: readonly string[], cap: number): string[] {
   if (values.length === 0) return [];
   const lines = [`## ${title}`];
   for (const value of values.slice(0, cap)) lines.push(`- ${value}`);
   return lines;
}

function formatFileSection(values: readonly string[]): string[] {
   if (values.length === 0) return [];
   return section("Files and Changes", values, values.length);
}

function capSummary(text: string, maxChars: number): string {
   if (text.length <= maxChars) return text;
   const lines = text.split("\n");
   while (lines.join("\n").length > maxChars && lines.length > 1) {
      const removable = lines.findLastIndex((line) => line.startsWith("- "));
      if (removable < 0) break;
      lines.splice(removable, 1);
   }
   const result = lines.join("\n");
   return result.length <= maxChars ? result : `${result.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Compile a deterministic zero-LLM summary from removed messages and Pi's selected tail. */
export function compileCompactionSummary(input: CompactionInput): Result<CompactionOutput, CompactionError> {
   if (!Array.isArray(input.messagesToSummarize)) {
      return { ok: false, error: { _tag: "CompactionError", message: "Compaction messages must be an array" } };
   }
   const limits = {
      maxChars: Math.max(1_000, Math.floor(input.limits?.maxChars ?? DEFAULT_LIMITS.maxChars)),
      maxItemsPerSection: Math.max(
         1,
         Math.floor(input.limits?.maxItemsPerSection ?? DEFAULT_LIMITS.maxItemsPerSection)
      ),
      maxBriefLines: Math.max(1, Math.floor(input.limits?.maxBriefLines ?? DEFAULT_LIMITS.maxBriefLines)),
      maxRecentTailChars: Math.max(0, Math.floor(input.limits?.maxRecentTailChars ?? DEFAULT_LIMITS.maxRecentTailChars))
   };
   const sections = buildSections(input, limits);
   if (sections.recent.length > 0) {
      const recent = sections.recent[0].slice(0, limits.maxRecentTailChars);
      sections.recent = recent.length > 0 ? [recent] : [];
   }
   const outputLines: string[] = [
      "# Pi Constellation checkpoint",
      "# Deterministic extraction only. Verify details against the persisted session history."
   ];
   const sectionLines: Array<[CompactionSectionName, string[]]> = [
      ["Goal", section("Goal", sections.goal, limits.maxItemsPerSection)],
      [
         "Constraints and Preferences",
         section("Constraints and Preferences", sections.constraints, limits.maxItemsPerSection)
      ],
      ["Files and Changes", formatFileSection(sections.files)],
      ["Decisions and Progress", section("Decisions and Progress", sections.decisions, limits.maxItemsPerSection)],
      ["Errors and Blockers", section("Errors and Blockers", sections.errors, limits.maxItemsPerSection)],
      ["Next Actions", section("Next Actions", sections.next, limits.maxItemsPerSection)],
      [
         "Chronological Brief",
         section("Chronological Brief", sections.brief.slice(0, limits.maxBriefLines), limits.maxBriefLines)
      ],
      ["Recent Verbatim Tail", sections.recent.length > 0 ? section("Recent Verbatim Tail", sections.recent, 1) : []]
   ];
   const present: CompactionSectionName[] = [];
   for (const [name, lines] of sectionLines) {
      if (lines.length === 0) continue;
      present.push(name);
      outputLines.push("", ...lines);
   }
   outputLines.push(
      "",
      "Earlier conversation was compacted. Use session_inspect with the current session ID and a bracketed source ID to inspect the original context."
   );
   const summary = capSummary(outputLines.join("\n"), limits.maxChars);
   return { ok: true, value: { summary, sections: present, estimatedTokens: Math.ceil(summary.length / 4) } };
}

/** Merge two deterministic summaries by preserving section items in chronological order. */
export function mergeCompactionSummaries(previous: string | undefined, fresh: string): string {
   const previousSections = parsePreviousSummary(previous);
   const freshSections = parsePreviousSummary(fresh);
   const result: SectionMap = {
      goal: [],
      constraints: [],
      files: [],
      decisions: [],
      errors: [],
      next: [],
      brief: [],
      recent: []
   };
   const keys: (keyof SectionMap)[] = [
      "goal",
      "constraints",
      "files",
      "decisions",
      "errors",
      "next",
      "brief",
      "recent"
   ];
   for (const key of keys) addUnique(result[key], [...previousSections[key], ...freshSections[key]], 100);
   const lines: string[] = [
      "# Pi Constellation checkpoint",
      "# Deterministic extraction only. Verify details against the persisted session history."
   ];
   const rendered: Array<[string, string[]]> = [
      ["Goal", result.goal],
      ["Constraints and Preferences", result.constraints],
      ["Files and Changes", result.files],
      ["Decisions and Progress", result.decisions],
      ["Errors and Blockers", result.errors],
      ["Next Actions", result.next],
      ["Chronological Brief", result.brief],
      ["Recent Verbatim Tail", result.recent]
   ];
   for (const [title, values] of rendered) {
      if (values.length === 0) continue;
      lines.push("", `## ${title}`, ...values.map((value) => `- ${value}`));
   }
   return capSummary(lines.join("\n"), DEFAULT_LIMITS.maxChars);
}
