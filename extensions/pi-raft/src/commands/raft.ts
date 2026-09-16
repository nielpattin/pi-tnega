import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { RaftState } from "../raft-state.js";
import { truncateMiddle } from "../util.js";
import type { RaftUiController } from "../ui/controller.js";
import fs from "node:fs";
import path from "node:path";
interface RaftCommandDeps {
  state: RaftState;
  raftUi: RaftUiController;
  refreshCodePreviewSettings?: () => void;
  refreshToolDisplay?: () => void;
}

const extractContentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const p = part as Record<string, unknown>;
        return typeof p.text === "string" ? p.text : typeof p.type === "string" ? p.type : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
};

const summarizeLogLine = (entry: unknown): string => {
  if (typeof entry !== "object" || entry === null) return truncateMiddle(String(entry), 200);
  const record = entry as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const tool = typeof record.toolName === "string" ? record.toolName : undefined;
  // Pi session lines and worker message_end both wrap a { role, content } message.
  const msg = record.message;
  if (typeof msg === "object" && msg !== null && !Array.isArray(msg)) {
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "message";
    const model = typeof m.model === "string" ? m.model : undefined;
    const text = extractContentText(m.content);
    const body = (text || JSON.stringify(m)).replace(/\s+/g, " ");
    return `${role}${model ? ` [${model}]` : ""}: ${truncateMiddle(body, 160)}`;
  }
  if (type) {
    const bits = [type];
    if (tool) bits.push(tool);
    const model = typeof record.modelId === "string" ? record.modelId : undefined;
    const provider = typeof record.provider === "string" && !model ? record.provider : undefined;
    if (provider) bits.push(provider);
    if (model) bits.push(model);
    return bits.join(" ");
  }
  return truncateMiddle(JSON.stringify(record), 160);
};

export function registerRaftCommand(pi: ExtensionAPI, deps: RaftCommandDeps): void {
  const { state, raftUi } = deps;
  pi.registerCommand("raft", {
    description: "Open Raft dashboard, reload, or manage child agents",
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      const subcommands = [
        "status",
        "dashboard",
        "settings",
        "reload",
        "providers",
        "agents",
        "log",
        "export-log",
        "stop",
        "remove",
        "kill",
      ];
      const firstSpace = argumentPrefix.indexOf(" ");
      if (firstSpace < 0) {
        const matches = subcommands.filter((name) => name.startsWith(argumentPrefix));
        return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
      }
      const subcommand = argumentPrefix.slice(0, firstSpace);
      const idPrefix = argumentPrefix.slice(firstSpace + 1);
      if (!state.initialized) return null;
      const items: Array<{ value: string; label: string; description: string }> = [];
      try {
        for (const agent of state.agents.list()) {
          const short = agent.id.slice(0, 8);
          items.push({
            value: short,
            label: short,
            description: `${agent.status} ${agent.runner} agent · ${agent.name}`,
          });
        }
      } catch {
        /* agents not initialized */
      }
      const filtered = items.filter((item) => item.value.startsWith(idPrefix));
      return filtered.length > 0 ? filtered : null;
    },
    async handler(argumentsText, context) {
      const [command = "dashboard", ...argumentsList] = argumentsText
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      await state.ensure(context);
      if (command === "reload") {
        raftUi.stop();
        try {
          await state.initialize(context);
        } catch (error) {
          raftUi.stop();
          throw error;
        }
        if (state.kernelReloadRequired) {
          await context.reload();
          return;
        }
        context.ui.notify("Pi Raft reloaded", "info");
        // initialize() reloads configuration, so an externally edited
        // ui.toolDisplay must re-render existing transcript cards too.
        deps.refreshToolDisplay?.();
        return;
      }
      if (command === "settings") {
        const { openRaftSettings } = await import("../ui/settings.js");
        await openRaftSettings(context, {
          reloadResources: () => context.reload(),
          state,
          // Only card-affecting preferences pay for a transcript refresh:
          // refreshToolDisplay re-renders every raft_exec card, so gating it
          // on the display sections keeps unrelated saves off the transcript.
          onConfigApplied: (id) => {
            if (id.startsWith("codePreview.")) {
              deps.refreshCodePreviewSettings?.();
              deps.refreshToolDisplay?.();
            } else if (id === "ui.toolDisplay" || id === "ui.showAgentToolPreview") {
              deps.refreshToolDisplay?.();
            }
          },
        });
        return;
      }
      if (command === "dashboard" || command === "ui") {
        await raftUi.openDashboard(context);
        return;
      }
      if (command === "providers") {
        const providers = state.registry.providers();
        context.ui.notify(
          providers.map((provider) => `${provider.name} — ${provider.description}`).join("\n"),
          "info",
        );
        return;
      }
      if (command === "agents") {
        const agents = state.agents.list();
        context.ui.notify(
          agents.length > 0
            ? agents
                .map(
                  (agent) =>
                    `${agent.id.slice(0, 8)} ${agent.status} ${agent.runner}/${agent.transport} — ${agent.name}`,
                )
                .join("\n")
            : "No Raft agents",
          "info",
        );
        return;
      }
      if (command === "log") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /raft log <id> [--lines N] [--before N]", "warning");
          return;
        }
        let lines = 40;
        let before: number | undefined;
        for (let i = 1; i < argumentsList.length; i++) {
          const arg = argumentsList[i]!;
          if ((arg === "--lines" || arg === "-n") && i + 1 < argumentsList.length) {
            const n = Number(argumentsList[++i]);
            if (n > 0) lines = Math.min(n, 5000);
          } else if (arg === "--before" && i + 1 < argumentsList.length) {
            const b = Number(argumentsList[++i]);
            if (b >= 0) before = b;
          }
        }
        try {
          const log = state.agents.readLog(id, {
            lines,
            ...(before !== undefined ? { before } : {}),
          });
          const parts: string[] = [`Agent ${log.id} · ${log.logFile}`];
          if (log.events.length > 0) {
            parts.push(`── events (last ${log.events.length} lines) ──`);
            for (const line of log.events) parts.push(summarizeLogLine(line.parsed ?? line.raw));
          }
          context.ui.notify(
            parts.length > 1
              ? truncateMiddle(parts.join("\n"), 8000)
              : `No log found for agent ${id}`,
            "info",
          );
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "export-log") {
        const id = argumentsList[0];
        const destArg = argumentsList.slice(1).join(" ");
        if (!id) {
          context.ui.notify("Usage: /raft export-log <id> [path]", "warning");
          return;
        }
        try {
          const dest = path.resolve(destArg || path.join("raft-logs", `export-${Date.now()}`));
          fs.mkdirSync(dest, { recursive: true });
          const runDir = state.agents.runDirectory(id);
          const status = state.agents.status(id);
          const label = status.name;
          let copied: string[] = [];
          if (runDir && fs.existsSync(runDir)) {
            fs.cpSync(runDir, dest, { recursive: true });
            copied.push("run/");
          }
          if (copied.length === 0) {
            context.ui.notify(`No log files found for ${label}`, "warning");
            return;
          }
          context.ui.notify(`Exported ${label} log → ${dest} (${copied.join(", ")})`, "info");
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "stop") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /raft stop <id>", "warning");
          return;
        }
        const agent = state.agents.list().find((candidate) => candidate.id.startsWith(id));
        if (!agent) {
          context.ui.notify(`Unknown Raft agent: ${id}`, "error");
          return;
        }
        await state.agents.stop(agent.id);
        context.ui.notify(`Stopped Raft agent ${agent.id.slice(0, 8)}`, "info");
        return;
      }
      if (command === "remove" || command === "kill") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /raft remove <id>", "warning");
          return;
        }
        const agent = state.agents.list().find((candidate) => candidate.id.startsWith(id));
        if (!agent) {
          context.ui.notify(`Unknown Raft agent: ${id}`, "error");
          return;
        }
        await state.agents.stop(agent.id);
        await state.agents.cleanup(agent.id);
        context.ui.notify(`Removed Raft agent ${agent.id.slice(0, 8)}`, "info");
        return;
      }
      if (command !== "status") {
        context.ui.notify(
          "Usage: /raft [status|dashboard|reload|providers|agents|log <id>|export-log <id>|stop <id>|remove <id>|kill <id>]",
          "warning",
        );
        return;
      }
      const config = state.config;
      context.ui.notify(
        [
          `cwd: ${state.cwd}`,
          `providers: ${state.registry
            .providers()
            .map((provider) => provider.name)
            .join(", ")}`,
          `runner: ${config.agents.runner} · transport: ${config.agents.transport} · model: ${
            config.agents.runner === "claude"
              ? config.agents.claude.model || "Claude default"
              : config.agents.model || "inherit"
          }`,
          `agent limits: concurrency ${config.agents.maxConcurrent}, per execution ${config.agents.maxPerExecution}, depth ${config.agents.maxDepth}`,
          `MCP: ${config.tools.mcp.enabled ? "enabled" : "disabled"}`,
          `UI: ${config.appearance.ui.enabled ? `${config.appearance.ui.widget} widget above chat` : "disabled"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
