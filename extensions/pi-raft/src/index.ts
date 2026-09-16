import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultCodePreviewSettings } from "./ui/code-preview.js";
import { type RaftToolShellDecorator, withCodePreviewShell } from "./ui/code-preview-shell.js";
import { registerRaftCommand } from "./commands/raft.js";
import { DEFAULT_RAFT_CONFIG } from "./config.js";
import { registerCompactionHook } from "./compaction/hook.js";
import { compactAtConfiguredThreshold } from "./compaction/threshold.js";
import { RaftToolLifecycle, ownsRaftToolSource } from "./core/tool-ownership.js";
import {
  expandSkillDirMarkersForRead,
  expandSkillDirMarkersInSkillBlock,
} from "./core/skill-dir.js";
import {
  raftExecutionKernelGuidance,
  defaultRaftExecutionGuidance,
} from "./core/system-guidance.js";
import {
  RAFT_EXECUTION_GUIDANCE_SLOT,
  resolveRaftModelGuidance,
} from "./components/model-guidance.js";
import { restoreSkillsInPrompt } from "./core/skill-prompt.js";
import { raftSkillPaths } from "./core/kernel-skills.js";
import { RaftDirectToolApproval, mergeRaftApprovalUsage } from "./core/direct-tool-approval.js";
import { buildSkillReferenceGuidance } from "./core/skill-references.js";
import { createRaftExecTool } from "./raft-exec-tool.js";
import { RaftState } from "./raft-state.js";
import { piHostCompatibilityWarning } from "./host-compatibility.js";
import { RAFT_COMPONENT_REGISTER_EVENT, type RaftComponentRegistration } from "./protocol.js";
import { RaftUiController } from "./ui/controller.js";
import { RaftToolDisplayController } from "./ui/tool-display.js";
import { configureHighlighting } from "./ui/highlight.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the Raft skills bundled with this extension. Resolved
// relative to the extension entry so it works in the installed package.
// Contributed via resources_discover so child Pi processes that load Raft
// with -e (child agents) discover the same kernel-specific tree as Main.
// The package manifest exposes no skills; selecting exactly one tree avoids
// canonical-name collisions.
const RAFT_EXTENSION_ENTRY_PATH = path.resolve(fileURLToPath(import.meta.url));
const RAFT_ENTRY_DIR = path.dirname(RAFT_EXTENSION_ENTRY_PATH);
const RAFT_RUNTIME_PATHS = {
  extension: RAFT_EXTENSION_ENTRY_PATH,
  worker: path.join(RAFT_ENTRY_DIR, "worker.js"),
  skills: path.resolve(RAFT_ENTRY_DIR, "..", "skillsets"),
};
const RAFT_SKILLS_DIR = RAFT_RUNTIME_PATHS.skills;

const componentRegistrationFrom = (value: unknown): RaftComponentRegistration | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const registration = value as Partial<RaftComponentRegistration>;
  const component = registration.component;
  if (
    registration.version !== 1 ||
    typeof component !== "object" ||
    component === null ||
    typeof component.name !== "string" ||
    typeof component.activate !== "function"
  ) {
    return undefined;
  }
  return registration as RaftComponentRegistration;
};

const SKILL_REFERENCE_CUSTOM_TYPE = "pi-raft-skill-reference";

export default async function piRaft(pi: ExtensionAPI): Promise<void> {
  const codePreviewSettings = defaultCodePreviewSettings();
  const decorateShell: RaftToolShellDecorator = withCodePreviewShell;
  let compatibilityWarningShown = false;
  configureHighlighting(codePreviewSettings.shikiTheme, codePreviewSettings.syntaxHighlighting);
  const state = new RaftState(pi, { paths: RAFT_RUNTIME_PATHS });
  const directToolApproval = new RaftDirectToolApproval(
    pi,
    () => state.config,
    state.sessionApprovals,
  );
  const raftUi = new RaftUiController(state, codePreviewSettings);
  const toolDisplay = new RaftToolDisplayController();

  const unsubscribeComponentRegistration = pi.events.on(
    RAFT_COMPONENT_REGISTER_EVENT,
    (value: unknown) => {
      const registration = componentRegistrationFrom(value);
      if (!registration) throw new Error("Invalid Pi Raft component registration");
      state.registerExternalComponent(
        registration.component,
        registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
      );
    },
  );

  pi.on("resources_discover", async (_event, context) => {
    if (!state.bootstrapped) await state.bootstrap(context);
    return { skillPaths: raftSkillPaths(RAFT_SKILLS_DIR, state.config.execution.executor.kernel) };
  });

  const raftTool = createRaftExecTool(state, codePreviewSettings, decorateShell, toolDisplay);
  const refreshCodePreviewSettings = (): void => {
    Object.assign(codePreviewSettings, state.config.appearance.codePreview);
    configureHighlighting(codePreviewSettings.shikiTheme, codePreviewSettings.syntaxHighlighting);
  };
  const raftToolLifecycle = new RaftToolLifecycle(
    () => ownsRaftToolSource(pi.getAllTools(), RAFT_EXTENSION_ENTRY_PATH),
    () => (state.initialized ? state.execution.authorizer : undefined),
    () => (state.initialized ? directToolApproval : undefined),
  );

  pi.registerTool(raftTool);
  const applyRaftMode = (): void => {
    Object.assign(
      raftTool,
      createRaftExecTool(state, codePreviewSettings, decorateShell, toolDisplay),
    );
    pi.registerTool(raftTool);
  };

  const cleanupActivationSideEffects = (): void => {
    raftUi.stop();
  };
  state.setActivationHook(async (context) => {
    refreshCodePreviewSettings();
    applyRaftMode();
    raftUi.start(context);
  }, cleanupActivationSideEffects);

  pi.on("session_start", async (_event, context) => {
    directToolApproval.clear();
    toolDisplay.clear();
    raftUi.stop();
    if (!compatibilityWarningShown) {
      compatibilityWarningShown = true;
      const warning = piHostCompatibilityWarning();
      if (warning) {
        console.warn(`[pi-raft] ${warning}`);
        if (context.hasUI) context.ui.notify(warning, "warning");
      }
    }
    await state.bootstrap(context);
    refreshCodePreviewSettings();
    applyRaftMode();
    if (state.shouldEagerlyActivate(context)) await state.ensure(context);
  });

  // Branch changes move the leaf: emitted echoes and spent reminder budget
  // must track it exactly. Rewind removes abandoned-branch residue.
  pi.on("session_tree", async (_event, context) => {
    // Pi emits session_tree before it clears and rebuilds the transcript:
    // drop card invalidators from abandoned branches so a later display-mode
    // switch only refreshes cards registered by the rebuilt active branch.
    toolDisplay.clear();
    return undefined;
  });

  pi.on("turn_end", async (event, context) => {
    // Speculation never crosses a turn boundary; registry.endInvocation already
    // dropped entries for completed raft_exec runs, this catches turns where
    // the program never executed (type errors, aborts).
    if (state.initialized) state.resetSpeculation();
  });

  pi.on("agent_settled", async (event, context) => {
    if (!state.initialized) {
      await compactAtConfiguredThreshold(context, state.config);
      return;
    }
    // Keep the completed widget mounted until a newer Raft run replaces it.
    // Removing rows at settle would pull the editor and latest chat content upward.
    // Pi's compact API is callback-based. Await the controller's Promise here
    // so ExtensionRunner does not finish this handler (and Pi does not publish
    // its public agent_settled event) before compaction settles.
    await state.compact.maybeCommit(context);
    await compactAtConfiguredThreshold(context, state.config);
  });

  // Speculative PTC: follow raft_exec argument streaming and pre-launch
  // literal-argument read calls so their latency hides behind generation.
  pi.on("message_start", () => {
    state.speculationTap?.reset();
  });

  pi.on("message_update", (event, context) => {
    if (!state.initialized) return;
    state.speculationTap?.handleMessageUpdate(event, context);
  });

  pi.on("tool_call", (event, context) => raftToolLifecycle.toolCall(event, context));

  // Pi 0.80.6 intentionally ignores `isError` returned by custom-tool
  // execute(). Repair the finalized outer result through official middleware.
  pi.on("tool_result", (event) => raftToolLifecycle.toolResult(event));

  pi.on("tool_result", (event, context) => {
    if (event.toolName !== "read" || event.isError) return undefined;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = expandSkillDirMarkersForRead(part.text, event.input, context.cwd);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "toolResult") return undefined;
    const message = event.message as { toolCallId: string; usage?: Usage };
    const usage = directToolApproval.takeUsage(message.toolCallId);
    if (!usage) return undefined;
    return {
      message: {
        ...event.message,
        usage: mergeRaftApprovalUsage(message.usage, usage),
      } as typeof event.message,
    };
  });

  // Deterministic, LLM-free compaction is registered unconditionally and is
  // active by default. The documented "pi" escape hatch returns early so
  // pi-core's own summarization proceeds normally.
  registerCompactionHook(pi, {
    getEngine: () =>
      state.cwd
        ? state.config.lifecycle.compaction.engine
        : DEFAULT_RAFT_CONFIG.lifecycle.compaction.engine,
    getTargetContextRatio: () =>
      state.cwd
        ? state.config.lifecycle.compaction.targetContextRatio
        : DEFAULT_RAFT_CONFIG.lifecycle.compaction.targetContextRatio,
    getThresholdContextRatio: (modelKey) =>
      state.cwd
        ? state.config.lifecycle.compaction.thresholds[modelKey]
        : DEFAULT_RAFT_CONFIG.lifecycle.compaction.thresholds[modelKey],
    getThresholdTokens: (modelKey) =>
      state.cwd
        ? state.config.lifecycle.compaction.tokenThresholds[modelKey]
        : DEFAULT_RAFT_CONFIG.lifecycle.compaction.tokenThresholds[modelKey],
  });

  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "user") return message;
      if (typeof message.content === "string") {
        const content = expandSkillDirMarkersInSkillBlock(message.content);
        if (content === message.content) return message;
        changed = true;
        return { ...message, content };
      }
      let messageChanged = false;
      const content = message.content.map((part) => {
        if (part.type !== "text") return part;
        const text = expandSkillDirMarkersInSkillBlock(part.text);
        if (text === part.text) return part;
        changed = true;
        messageChanged = true;
        return { ...part, text };
      });
      return messageChanged ? { ...message, content } : message;
    });
    return changed ? { messages } : undefined;
  });

  pi.on("before_agent_start", async (event, context) => {
    const config = state.bootstrapped ? state.config : DEFAULT_RAFT_CONFIG;
    if (!pi.getActiveTools().includes("raft_exec")) return;
    const skills = event.systemPromptOptions.skills ?? [];
    // Pi omits its entire skill catalog when the active tool set lacks a tool
    // named read. Restore Pi's discovered catalog (already bound to one skill
    // tree) so the invoked-skill loader keeps working with the guest surface unchanged.
    const systemPrompt = restoreSkillsInPrompt(event.systemPrompt, skills);
    // Pi expands the invoked skill into the user message, but wrappers may
    // delegate by name. Resolve only explicit invocation lines so progressive
    // skill loading survives with the guest surface unchanged.
    // Turn-derived: delivered via the message channel (below), never the
    // system prompt, so the cached system prefix stays byte-stable.
    const skillReferenceGuidance = buildSkillReferenceGuidance(event.prompt, skills);
    const currentModel = context.model
      ? `${context.model.provider}/${context.model.id}`
      : undefined;
    const resolvedGuidance = resolveRaftModelGuidance(state.modelGuidance(), {
      ...(currentModel ? { model: currentModel } : {}),
      target: process.env.PI_RAFT_PARENT_RUN ? "participant" : "main",
      defaults: [
        {
          slot: RAFT_EXECUTION_GUIDANCE_SLOT,
          content: defaultRaftExecutionGuidance(
            config.execution.executor.kernel,
            config.execution.executor.pythonRuntime,
          ),
        },
      ],
    });
    // Only turn-stable sections go into the system prompt. Anything derived
    // from the current prompt (skill references) rides
    // the message channel so provider prefix caches never cold-prefill.
    const guidance = [
      raftExecutionKernelGuidance(
        config.execution.executor.kernel,
        config.execution.executor.pythonRuntime,
      ),
      resolvedGuidance.slotText,
      resolvedGuidance.appendText,
    ]
      .filter((section): section is string => Boolean(section))
      .join("\n\n");
    // Turn-varying content (skill reference guidance) is delivered here as a
    // persistent message, not appended to the system prompt. Keeping the
    // system prompt byte-identical across turns is what lets provider prefix
    // caches (e.g. DeepSeek) stay warm.
    if (!skillReferenceGuidance) return { systemPrompt: `${systemPrompt}\n\n${guidance}` };
    return {
      systemPrompt: `${systemPrompt}\n\n${guidance}`,
      message: {
        customType: SKILL_REFERENCE_CUSTOM_TYPE,
        content: skillReferenceGuidance,
        display: false,
        details: {},
      },
    };
  });

  pi.on("session_shutdown", async (_event) => {
    unsubscribeComponentRegistration();
    directToolApproval.clear();
    toolDisplay.clear();
    try {
      await state.shutdown();
    } finally {
      raftUi.stop();
      raftToolLifecycle.clear();
    }
  });

  registerRaftCommand(pi, {
    state,
    raftUi,
    refreshCodePreviewSettings,
    refreshToolDisplay: () => toolDisplay.refresh(),
  });
}

export * from "./audit/index.js";
export * from "./protocol.js";
