import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { uuidv7 } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveChildSessionDirectory } from "./child-session-dir.ts";
import {
   consumeAgentExitSidecar,
   emptySessionStats,
   readSessionStats,
   waitForAgentCompletion,
   type SessionStats,
   type AgentCompletionResult
} from "./agent-completion.ts";
import { getAgentActivityFile } from "./agent-activity.ts";
import type { AgentActivityState } from "../domain.js";
import { AGENT_SYSTEM_INSTRUCTION } from "../agent-prompt.ts";

export type AgentSplitDirection = "right" | "down";

export interface AgentHerdrTab {
   readonly tabId: string;
   readonly rootPaneId: string;
}

export interface AgentHerdrOps {
   readonly available: () => boolean;
   readonly currentTabPaneCount?: () => number | undefined;
   readonly createTab: (name: string, cwd: string) => AgentHerdrTab;
   readonly createPane: (name: string, cwd: string, fromPaneId?: string, direction?: AgentSplitDirection) => string;
   readonly runScript: (paneId: string, scriptPath: string) => void;
   readonly readPane: (paneId: string) => string;
   readonly inspectPane: (paneId: string) => Promise<"present" | "missing" | "unavailable">;
   readonly closePane: (paneId: string) => void;
   readonly closeTab: (tabId: string) => void;
   readonly renamePane: (paneId: string, name: string) => void;
   readonly sendText: (paneId: string, text: string) => void;
}

export interface AgentLaunchRequest {
   readonly id: string;
   readonly name: string;
   readonly prompt: string;
   readonly cwd: string;
   readonly sessionFile: string;
   readonly activityFile?: string;
   readonly childExtensionPath?: string;
   readonly additionalExtensionPaths?: readonly string[];
   readonly tools?: readonly string[];
   readonly systemPrompt?: string;
   readonly model?: string;
   readonly thinking?: string;
   readonly piCommand?: string;
   readonly useHerdr?: boolean;
   readonly herdrOps?: AgentHerdrOps;
   readonly existingPaneId?: string;
   readonly splitFromPaneId?: string;
   readonly splitDirection?: AgentSplitDirection;
   readonly onActivity?: (activity: AgentActivityState) => void;
}

export interface AgentSessionMetadata {
   readonly sessionFile: string;
   readonly sessionId?: string;
   readonly activityFile: string;
   readonly paneId?: string;
   readonly model?: string;
   readonly thinking?: string;
   readonly systemPrompt: string;
}

export interface ExternalAgentOutcome {
   readonly ok: boolean;
   readonly output: string;
   readonly error?: string;
   readonly aborted: boolean;
   readonly sessionFile: string;
   readonly sessionId?: string;
   readonly activityFile: string;
   readonly paneId?: string;
   readonly stats: SessionStats;
}

export interface ExternalAgentHandle {
   readonly metadata: AgentSessionMetadata;
   readonly completion: Promise<ExternalAgentOutcome>;
   readonly abort: () => Promise<void>;
   readonly control: (text: string) => Promise<void>;
}

export interface AgentArtifactsOptions {
   readonly id: string;
   readonly parentSessionFile?: string;
   readonly agentDir?: string;
}

export function createAgentSessionFile(options: AgentArtifactsOptions): string {
   const root =
      deriveChildSessionDirectory(options.parentSessionFile) ??
      join(
         options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? tmpdir(), ".pi", "agent"),
         "agent-sessions"
      );
   mkdirSync(root, { recursive: true });
   return join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}_${uuidv7()}.jsonl`);
}

export function shellQuote(value: string): string {
   return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildSystemPrompt(request: AgentLaunchRequest): string {
   return [AGENT_SYSTEM_INSTRUCTION, request.systemPrompt?.trim()]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
}

export function resolveAppendSystemPromptSource(cwd: string, agentDir = getAgentDir()): string | undefined {
   const projectSource = join(resolve(cwd), ".pi", "APPEND_SYSTEM.md");
   if (existsSync(projectSource)) return undefined;
   const globalSource = join(resolve(agentDir), "APPEND_SYSTEM.md");
   return existsSync(globalSource) ? globalSource : undefined;
}

export interface AgentCommand {
   readonly executable: string;
   readonly args: readonly string[];
   readonly shellCommand: string;
}

export function buildAgentCommand(request: AgentLaunchRequest): AgentCommand {
   const executable = request.piCommand ?? process.env.PI_COMMAND ?? "pi";
   const childExtensionPath =
      request.childExtensionPath ?? fileURLToPath(new URL("../agent-child.ts", import.meta.url));
   const extensionPaths = [childExtensionPath, ...(request.additionalExtensionPaths ?? [])];
   const tools = [...(request.tools ?? [])];
   const args: string[] = ["--session", resolve(request.sessionFile)];
   for (const extensionPath of extensionPaths) args.push("--extension", resolve(extensionPath));
   if (request.model) args.push("--model", request.model);
   if (request.thinking) args.push("--thinking", request.thinking);
   if (tools.length > 0) args.push("--tools", tools.join(","));
   else args.push("--no-tools");
   args.push("--exclude-tools", "ask_user,agent_spawn,agent_list,agent_cancel");
   const appendSystemPrompt = resolveAppendSystemPromptSource(request.cwd);
   if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
   args.push("--", request.prompt);
   return {
      executable,
      args,
      shellCommand: [shellQuote(executable), ...args.map(shellQuote)].join(" ")
   };
}

export function buildAgentLaunchScript(request: AgentLaunchRequest, command = buildAgentCommand(request)): string {
   const environment: Record<string, string> = {
      HERDR_ENV: "0",
      PI_AGENT_ID: request.id,
      PI_AGENT_NAME: request.name,
      PI_AGENT_SESSION: resolve(request.sessionFile),
      PI_AGENT_ACTIVITY_FILE: resolve(request.activityFile ?? getAgentActivityFile(request.sessionFile)),
      PI_AGENT_AUTO_EXIT: "1",
      PI_AGENT_SYSTEM_PROMPT: buildSystemPrompt(request)
   };
   const assignments = Object.entries(environment)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
   return [
      "#!/bin/sh",
      "set +e",
      `${assignments} ${command.shellCommand}`,
      "code=$?",
      "printf '\\n__PI_AGENT_DONE_%s__\\n' \"$code\"",
      'exit "$code"',
      ""
   ].join("\n");
}

function commandAvailable(command: string): boolean {
   try {
      execFileSync(command, ["--version"], { stdio: "ignore", timeout: 2_000 });
      return true;
   } catch {
      return false;
   }
}

function herdrAvailable(): boolean {
   return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID) && commandAvailable("herdr");
}

function parseJsonOutput(output: string): any {
   try {
      return JSON.parse(output);
   } catch {
      return undefined;
   }
}

function createHerdrPane(
   name: string,
   cwd: string,
   fromPaneId?: string,
   direction: AgentSplitDirection = "right"
): string {
   const parentPane = fromPaneId ?? process.env.HERDR_PANE_ID;
   if (!parentPane) throw new Error("HERDR_PANE_ID is not set");
   const output = execFileSync(
      "herdr",
      ["pane", "split", parentPane, "--direction", direction, "--no-focus", "--cwd", cwd],
      { encoding: "utf8", timeout: 10_000 }
   );
   const parsed = parseJsonOutput(output);
   const paneId = parsed?.result?.pane?.pane_id;
   if (typeof paneId !== "string" || paneId.length === 0) throw new Error("Herdr did not return a agent pane id");
   try {
      execFileSync("herdr", ["pane", "rename", paneId, name], { stdio: "ignore", timeout: 5_000 });
   } catch {
      // Pane naming is cosmetic.
   }
   return paneId;
}

function runHerdrScript(paneId: string, scriptPath: string): void {
   execFileSync("herdr", ["pane", "run", paneId, "bash", scriptPath], { stdio: "ignore", timeout: 10_000 });
}

function readHerdrPane(paneId: string): string {
   const output = execFileSync(
      "herdr",
      ["pane", "read", paneId, "--source", "recent", "--lines", "30", "--format", "text"],
      { encoding: "utf8", timeout: 5_000 }
   );
   const parsed = parseJsonOutput(output);
   return typeof parsed?.result?.text === "string" ? parsed.result.text : output;
}

async function inspectHerdrPane(paneId: string): Promise<"present" | "missing" | "unavailable"> {
   try {
      execFileSync("herdr", ["pane", "get", paneId], { stdio: "ignore", timeout: 5_000 });
      return "present";
   } catch {
      return "missing";
   }
}

function currentHerdrTabPaneCount(): number | undefined {
   const parentPaneId = process.env.HERDR_PANE_ID;
   if (!parentPaneId) return undefined;
   try {
      const paneOutput = execFileSync("herdr", ["pane", "get", parentPaneId], { encoding: "utf8", timeout: 5_000 });
      const pane = parseJsonOutput(paneOutput);
      const tabId = pane?.result?.pane?.tab_id;
      if (typeof tabId !== "string" || tabId.length === 0) return undefined;
      const tabOutput = execFileSync("herdr", ["tab", "get", tabId], { encoding: "utf8", timeout: 5_000 });
      const tab = parseJsonOutput(tabOutput);
      const paneCount = tab?.result?.tab?.pane_count;
      return typeof paneCount === "number" && Number.isFinite(paneCount) && paneCount >= 0 ? paneCount : undefined;
   } catch {
      return undefined;
   }
}

function closeHerdrPane(paneId: string): void {
   try {
      execFileSync("herdr", ["pane", "close", paneId], { stdio: "ignore", timeout: 5_000 });
   } catch {
      // The pane may already be gone.
   }
}

function renameHerdrPane(paneId: string, name: string): void {
   try {
      execFileSync("herdr", ["pane", "rename", paneId, name], { stdio: "ignore", timeout: 5_000 });
   } catch {
      // Pane naming is cosmetic.
   }
}

function createHerdrTab(name: string, cwd: string): AgentHerdrTab {
   const args = ["tab", "create", "--label", name, "--cwd", cwd, "--no-focus"] as string[];
   const workspaceId = process.env.HERDR_WORKSPACE_ID;
   if (workspaceId) args.splice(2, 0, "--workspace", workspaceId);
   const output = execFileSync("herdr", args, { encoding: "utf8", timeout: 10_000 });
   const parsed = parseJsonOutput(output);
   const rootPaneId = parsed?.result?.root_pane?.pane_id;
   const tabId = parsed?.result?.tab?.tab_id;
   if (typeof rootPaneId !== "string" || rootPaneId.length === 0 || typeof tabId !== "string" || tabId.length === 0) {
      throw new Error("Herdr did not return a agent tab");
   }
   return { tabId, rootPaneId };
}

function closeHerdrTab(tabId: string): void {
   try {
      execFileSync("herdr", ["tab", "close", tabId], { stdio: "ignore", timeout: 5_000 });
   } catch {
      // The tab may already be gone.
   }
}

function readSessionResult(sessionFile: string): { output: string; sessionId?: string } {
   if (!existsSync(sessionFile)) return { output: "" };
   let sessionId: string | undefined;
   let output = "";
   try {
      for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
         if (!line.trim()) continue;
         let entry: any;
         try {
            entry = JSON.parse(line);
         } catch {
            continue;
         }
         if (entry?.type === "session" && typeof entry.id === "string") sessionId = entry.id;
         if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
         const text = Array.isArray(entry.message.content)
            ? entry.message.content
                 .filter((part: any) => part?.type === "text" && typeof part.text === "string")
                 .map((part: any) => part.text)
                 .join("\n")
                 .trim()
            : typeof entry.message.content === "string"
              ? entry.message.content.trim()
              : "";
         if (text) output = text;
         if (!output && entry.message.stopReason === "error" && typeof entry.message.errorMessage === "string") {
            output = `Agent error: ${entry.message.errorMessage}`;
         }
      }
   } catch {
      // The sidecar is authoritative for completion. A missing readable result is an empty result.
   }
   return { output, sessionId };
}

function outcomeFromCompletion(
   completion: AgentCompletionResult,
   request: AgentLaunchRequest,
   paneId?: string
): ExternalAgentOutcome {
   const session = readSessionResult(request.sessionFile);
   const stats = readSessionStats(request.sessionFile);
   if (completion.reason === "done") {
      return {
         ok: true,
         output: session.output,
         aborted: false,
         sessionFile: request.sessionFile,
         sessionId: session.sessionId,
         activityFile: request.activityFile ?? getAgentActivityFile(request.sessionFile),
         paneId,
         stats
      };
   }
   const error = completion.reason === "error" ? completion.errorMessage : completion.ping.message;
   return {
      ok: false,
      output: session.output,
      error: error || "Agent did not complete successfully.",
      aborted: false,
      sessionFile: request.sessionFile,
      sessionId: session.sessionId,
      activityFile: request.activityFile ?? getAgentActivityFile(request.sessionFile),
      paneId,
      stats
   };
}

export const defaultAgentHerdrOps: AgentHerdrOps = {
   available: () => herdrAvailable(),
   currentTabPaneCount: () => currentHerdrTabPaneCount(),
   createTab: (name, cwd) => createHerdrTab(name, cwd),
   createPane: (name, cwd, fromPaneId, direction) => createHerdrPane(name, cwd, fromPaneId, direction),
   runScript: (paneId, scriptPath) => runHerdrScript(paneId, scriptPath),
   readPane: (paneId) => readHerdrPane(paneId),
   inspectPane: (paneId) => inspectHerdrPane(paneId),
   closePane: (paneId) => closeHerdrPane(paneId),
   renamePane: (paneId, name) => renameHerdrPane(paneId, name),
   closeTab: (tabId) => closeHerdrTab(tabId),
   sendText: (paneId, text) => {
      execFileSync("herdr", ["pane", "send-text", paneId, text], { stdio: "ignore", timeout: 5_000 });
   }
};
export async function launchExternalAgent(request: AgentLaunchRequest): Promise<ExternalAgentHandle> {
   const sessionFile = resolve(request.sessionFile);
   const activityFile = resolve(request.activityFile ?? getAgentActivityFile(sessionFile));
   mkdirSync(dirname(sessionFile), { recursive: true });
   rmSync(`${sessionFile}.exit`, { force: true });
   const command = buildAgentCommand({ ...request, sessionFile, activityFile });
   const metadata: AgentSessionMetadata = {
      sessionFile,
      activityFile,
      model: request.model,
      thinking: request.thinking,
      systemPrompt: buildSystemPrompt(request)
   };

   let paneId: string | undefined;
   let child: ChildProcess | undefined;
   let processExitCode: number | null = null;
   let scriptPath: string | undefined;

   const spawnDirect = () => {
      const environment = {
         ...process.env,
         HERDR_ENV: "0",
         PI_AGENT_ID: request.id,
         PI_AGENT_NAME: request.name,
         PI_AGENT_SESSION: sessionFile,
         PI_AGENT_ACTIVITY_FILE: activityFile,
         PI_AGENT_AUTO_EXIT: "1",
         PI_AGENT_SYSTEM_PROMPT: buildSystemPrompt(request)
      };
      child = spawn(command.executable, command.args, {
         cwd: request.cwd,
         env: environment,
         stdio: ["pipe", "ignore", "ignore"]
      });
      child.once("error", () => {
         if (processExitCode === null) processExitCode = 1;
      });
      child.once("close", (code) => {
         processExitCode = code ?? 1;
      });
   };

   const ops = request.herdrOps ?? defaultAgentHerdrOps;
   const writeLaunchScript = () => {
      scriptPath = join(tmpdir(), "pi-subagent", `${request.id}.sh`);
      mkdirSync(dirname(scriptPath), { recursive: true });
      writeFileSync(scriptPath, buildAgentLaunchScript({ ...request, sessionFile, activityFile }, command), {
         mode: 0o700
      });
   };
   const herdrUsable = request.useHerdr !== false && ops.available();
   if (request.existingPaneId !== undefined && herdrUsable) {
      try {
         paneId = request.existingPaneId;
         ops.renamePane(paneId, request.name);
         writeLaunchScript();
         ops.runScript(paneId, scriptPath!);
      } catch {
         paneId = undefined;
         if (scriptPath) rmSync(scriptPath, { force: true });
         scriptPath = undefined;
      }
   }
   if (paneId === undefined) {
      if (herdrUsable) {
         try {
            paneId = ops.createPane(request.name, request.cwd, request.splitFromPaneId, request.splitDirection);
            writeLaunchScript();
            ops.runScript(paneId, scriptPath!);
         } catch {
            if (paneId) ops.closePane(paneId);
            paneId = undefined;
            if (scriptPath) rmSync(scriptPath, { force: true });
            scriptPath = undefined;
            spawnDirect();
         }
      } else {
         spawnDirect();
      }
   }

   const completionSignal = new AbortController();
   const completion = waitForAgentCompletion(completionSignal.signal, {
      intervalMs: 300,
      exitFile: `${sessionFile}.exit`,
      activityFile,
      runningChildId: request.id,
      readTerminalTail: paneId ? () => Promise.resolve(ops.readPane(paneId!)) : undefined,
      inspectPane: paneId ? () => ops.inspectPane(paneId!) : undefined,
      processExited: child ? () => processExitCode : undefined,
      onActivitySnapshot: request.onActivity
   })
      .then((result) => outcomeFromCompletion(result, { ...request, sessionFile, activityFile }, paneId))
      .catch((error) => {
         const session = readSessionResult(sessionFile);
         return {
            ok: false,
            output: session.output,
            error: completionSignal.signal.aborted
               ? "Agent was aborted."
               : error instanceof Error
                 ? error.message
                 : String(error),
            aborted: completionSignal.signal.aborted,
            sessionFile,
            sessionId: session.sessionId,
            activityFile,
            paneId,
            stats: emptySessionStats()
         } satisfies ExternalAgentOutcome;
      })
      .finally(() => {
         completionSignal.abort();
         // Leave Herdr panes and batch tabs open after settle so the run can
         // be inspected. Explicit agent_cancel still closes its own pane.
         if (child && !child.killed && processExitCode === null) child.kill("SIGTERM");
         if (scriptPath) rmSync(scriptPath, { force: true });
      });

   const abort = async () => {
      completionSignal.abort();
      if (child && !child.killed) {
         child.kill("SIGTERM");
         return;
      }
      if (paneId) ops.closePane(paneId);
   };
   const control = async (text: string) => {
      if (child?.stdin && !child.stdin.destroyed) {
         child.stdin.write(`${text}\n`);
         return;
      }
      if (paneId) {
         ops.sendText(paneId, text);
      }
   };

   return {
      metadata: { ...metadata, paneId },
      completion,
      abort,
      control
   };
}

export function consumeAgentCompletionSidecar(exitFile: string): AgentCompletionResult | null {
   return consumeAgentExitSidecar(exitFile);
}
