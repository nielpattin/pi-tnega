import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPermissionSystemCommand } from "./src/config-modal";
import { getGlobalConfigPath } from "./src/config-paths";
import type { PermissionForwardingDeps } from "./src/forwarded-permissions/polling";
import { ForwardingManager } from "./src/forwarding-manager";
import { AgentPrepHandler, PermissionGateHandler, SessionLifecycleHandler } from "./src/handlers";
import { buildInputForSurface } from "./src/input-normalizer";
import { requestPermissionDecisionFromUi } from "./src/permission-dialog";
import { registerPermissionRpcHandlers } from "./src/permission-event-rpc";
import { emitReadyEvent } from "./src/permission-events";
import { PermissionPrompter } from "./src/permission-prompter";
import { createAudiblePermissionDecisionRequester, type PermissionSoundExec } from "./src/permission-sound";
import { PermissionSession } from "./src/permission-session";
import {
   createExtensionRuntime,
   logResolvedConfigPaths,
   refreshExtensionConfig,
   saveExtensionConfig
} from "./src/runtime";
import type { PermissionsService } from "./src/service";
import { publishPermissionsService, unpublishPermissionsService } from "./src/service";
import { createSessionLogger } from "./src/session-logger";
import { isSubagentExecutionContext } from "./src/subagent-context";
import { subscribeSubagentLifecycle } from "./src/subagent-lifecycle-events";
import { SubagentSessionRegistry } from "./src/subagent-registry";
import { canResolveAskPermissionRequest, shouldAutoApprovePermissionState } from "./src/yolo-mode";

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
   const runtime = createExtensionRuntime();
   const subagentRegistry = new SubagentSessionRegistry();
   const maybeExec = (pi as unknown as { exec?: PermissionSoundExec }).exec;
   const requestPermissionDecisionWithSound = createAudiblePermissionDecisionRequester({
      agentDir: runtime.agentDir,
      exec: maybeExec ? maybeExec.bind(pi) : undefined,
      requestPermissionDecisionFromUi,
      warn: (message, error) => console.warn(message, error)
   });

   const prompter = new PermissionPrompter({
      getConfig: () => runtime.config,
      writeReviewLog: runtime.writeReviewLog.bind(runtime),
      subagentSessionsDir: runtime.subagentSessionsDir,
      forwardingDir: runtime.forwardingDir,
      registry: subagentRegistry,
      requestPermissionDecisionFromUi: requestPermissionDecisionWithSound
   });

   const forwardingDeps: PermissionForwardingDeps = {
      forwardingDir: runtime.forwardingDir,
      subagentSessionsDir: runtime.subagentSessionsDir,
      registry: subagentRegistry,
      logger: {
         writeReviewLog: runtime.writeReviewLog.bind(runtime),
         writeDebugLog: runtime.writeDebugLog.bind(runtime)
      },
      writeReviewLog: runtime.writeReviewLog.bind(runtime),
      requestPermissionDecisionFromUi: requestPermissionDecisionWithSound,
      shouldAutoApprove: () => shouldAutoApprovePermissionState("ask", runtime.config)
   };

   refreshExtensionConfig(runtime);

   const session = new PermissionSession(
      runtime,
      createSessionLogger(runtime),
      new ForwardingManager(runtime.subagentSessionsDir, forwardingDeps, subagentRegistry),
      {
         refreshExtensionConfig: (ctx) => refreshExtensionConfig(runtime, ctx),
         logResolvedConfigPaths: () => logResolvedConfigPaths(runtime),
         getConfig: () => runtime.config,
         canRequestPermissionConfirmation: (ctx) =>
            canResolveAskPermissionRequest({
               config: runtime.config,
               hasUI: ctx.hasUI,
               isSubagent: isSubagentExecutionContext(ctx, runtime.subagentSessionsDir, subagentRegistry)
            }),
         promptPermission: (ctx, details) => prompter.prompt(ctx, details)
      }
   );

   registerPermissionSystemCommand(pi, {
      getConfig: () => runtime.config,
      setConfig: (next, ctx) => saveExtensionConfig(runtime, next, ctx),
      getConfigPath: () => getGlobalConfigPath(runtime.agentDir),
      getComposedRules: () =>
         runtime.permissionManager.getComposedConfigRules(runtime.lastKnownActiveAgentName ?? undefined)
   });

   const rpcHandles = registerPermissionRpcHandlers(pi.events, {
      getPermissionManager: () => runtime.permissionManager,
      getSessionRules: () => runtime.sessionRules.getRuleset(),
      getRuntimeContext: () => runtime.runtimeContext,
      requestPermissionDecisionFromUi: requestPermissionDecisionWithSound,
      writeReviewLog: runtime.writeReviewLog.bind(runtime)
   });

   const permissionsService: PermissionsService = {
      checkPermission(surface, value, agentName) {
         const input = buildInputForSurface(surface, value);
         const sessionRules = runtime.sessionRules.getRuleset();
         return runtime.permissionManager.checkPermission(surface, input, agentName, sessionRules);
      },
      registerSubagentSession(sessionKey, info) {
         subagentRegistry.register(sessionKey, info);
      },
      unregisterSubagentSession(sessionKey) {
         subagentRegistry.unregister(sessionKey);
      },
      getToolPermission(toolName, agentName) {
         return runtime.permissionManager.getToolPermission(toolName, agentName);
      },
      approveSessionRule(surface, pattern) {
         session.approveSessionRule(surface, pattern);
      }
   };
   publishPermissionsService(permissionsService);

   // Subscribe to @nielpattin/pi-subagents' child lifecycle events so child
   // sessions register/unregister without the core calling us (ADR 0002).
   const unsubSubagentLifecycle = subscribeSubagentLifecycle(pi.events, subagentRegistry);

   emitReadyEvent(pi.events);

   const toolRegistry = {
      getAll: () => pi.getAllTools(),
      setActive: (names: string[]) => pi.setActiveTools(names)
   };

   const lifecycle = new SessionLifecycleHandler(session, () => {
      rpcHandles.unsubCheck();
      rpcHandles.unsubPrompt();
      unsubSubagentLifecycle();
      unpublishPermissionsService();
   });
   const agentPrep = new AgentPrepHandler(session, toolRegistry);
   const gates = new PermissionGateHandler(session, pi.events, toolRegistry);

   pi.on("session_start", (event, ctx) => lifecycle.handleSessionStart(event, ctx));
   pi.on("resources_discover", (event) => lifecycle.handleResourcesDiscover(event));
   pi.on("session_shutdown", () => lifecycle.handleSessionShutdown());
   pi.on("before_agent_start", (event, ctx) => agentPrep.handle(event, ctx));
   pi.on("input", (event, ctx) => gates.handleInput(event, ctx));
   pi.on("tool_call", (event, ctx) => gates.handleToolCall(event, ctx));
}
