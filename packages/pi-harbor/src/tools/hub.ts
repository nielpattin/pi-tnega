import { Type, type Static } from "typebox";
import { Effect } from "effect";
import { JobRegistry } from "../services/JobRegistry.js";
import { ProcessSupervisor } from "../services/ProcessSupervisor.js";
import { ShellExecutor } from "../services/ShellExecutor.js";

export const HubToolParamsSchema = Type.Object({
   op: Type.Union([
      Type.Literal("jobs"),
      Type.Literal("wait"),
      Type.Literal("cancel"),
      Type.Literal("exec"),
      Type.Literal("start"),
      Type.Literal("ps"),
      Type.Literal("logs"),
      Type.Literal("stop"),
      Type.Literal("restart"),
      Type.Literal("describe"),
      Type.Literal("send"),
      Type.Literal("inbox"),
      Type.Literal("list"),
      Type.Literal("wait-from")
   ]),
   target: Type.Optional(Type.Union([Type.Literal("jobs"), Type.Literal("process"), Type.Literal("message")])),
   ids: Type.Optional(Type.Array(Type.String())),
   id: Type.Optional(Type.String()),
   name: Type.Optional(Type.String()),
   command: Type.Optional(Type.String()),
   cwd: Type.Optional(Type.String()),
   env: Type.Optional(Type.Record(Type.String(), Type.String())),
   async: Type.Optional(Type.Boolean()),
   timeoutMs: Type.Optional(Type.Number()),
   signal: Type.Optional(Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL")])),
   ready: Type.Optional(
      Type.Object({
         log: Type.Optional(Type.String()),
         port: Type.Optional(Type.Number()),
         timeoutSec: Type.Optional(Type.Number())
      })
   ),
   to: Type.Optional(Type.String()),
   from: Type.Optional(Type.String()),
   message: Type.Optional(Type.String()),
   replyTo: Type.Optional(Type.String()),
   peek: Type.Optional(Type.Boolean()),
   lines: Type.Optional(Type.Number()),
   grep: Type.Optional(Type.String())
});

export type HubToolParams = Static<typeof HubToolParamsSchema>;

export const hubToolDefinition = {
   name: "hub",
   description: "Unified hub tool for job monitoring, process supervision, shell execution, and messaging.",
   parameters: HubToolParamsSchema
};

export interface HandleHubOptions {
   isWorker?: boolean;
}

export const handleHub = Effect.fn("hub.handleHub")(function* (params: HubToolParams, options?: HandleHubOptions) {
   if (options?.isWorker) {
      const workerOps = ["send", "inbox", "list", "wait-from", "exec"];
      if (!workerOps.includes(params.op)) {
         return { ok: false, error: `Operation "${params.op}" is restricted on worker sessions.` };
      }
      if (params.op === "exec" && params.async === true) {
         return { ok: false, error: "Workers cannot run shell commands asynchronously." };
      }
   }

   // Parameter validation guards
   if (params.op === "wait" && !params.target) {
      return { ok: false, error: 'op "wait" requires target parameter ("jobs", "process", or "message").' };
   }

   if (params.op === "wait-from" && !params.from) {
      return { ok: false, error: 'op "wait-from" requires "from" parameter.' };
   }

   if (params.op === "describe") {
      if (params.ids && params.ids.length > 0) {
         return { ok: false, error: 'op "describe" does not accept "ids" array; use single "id" or "name".' };
      }
      const hasId = typeof params.id === "string" && params.id.length > 0;
      const hasName = typeof params.name === "string" && params.name.length > 0;
      if ((hasId && hasName) || (!hasId && !hasName)) {
         return { ok: false, error: 'op "describe" requires exactly one of "id" or "name".' };
      }
   }

   switch (params.op) {
      case "jobs": {
         const registry = yield* JobRegistry;
         const jobs = yield* registry.list();
         return { ok: true, jobs };
      }

      case "wait": {
         if (params.target === "jobs") {
            const registry = yield* JobRegistry;
            const jobs = yield* registry.awaitSettlement(params.ids ?? [], params.timeoutMs);
            return { ok: true, jobs };
         }
         if (params.target === "process") {
            if (!params.name) {
               return { ok: false, error: 'op "wait" for target "process" requires "name" parameter.' };
            }
            const supervisor = yield* ProcessSupervisor;
            const proc = yield* supervisor.awaitExit(params.name, params.timeoutMs);
            return { ok: true, process: proc };
         }
         if (params.target === "message") {
            return { ok: true, messages: [] };
         }
         return { ok: false, error: `Invalid wait target "${params.target}".` };
      }

      case "cancel": {
         if (!params.id) {
            return { ok: false, error: 'op "cancel" requires "id" parameter.' };
         }
         const registry = yield* JobRegistry;
         const job = yield* registry.updateStatus(params.id, "cancelled");
         return { ok: true, cancelled: params.id, job };
      }

      case "exec": {
         if (!params.command) {
            return { ok: false, error: 'op "exec" requires "command" parameter.' };
         }
         if (params.async === true) {
            const supervisor = yield* ProcessSupervisor;
            const proc = yield* supervisor.start({
               name: params.name ?? `exec-${Date.now()}`,
               command: params.command,
               cwd: params.cwd,
               env: params.env
            });
            return { ok: true, process: proc };
         } else {
            const executor = yield* ShellExecutor;
            const res = yield* executor.execSync(params.command, {
               cwd: params.cwd,
               env: params.env,
               timeoutMs: params.timeoutMs
            });
            return { ok: true, stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
         }
      }

      case "start": {
         if (!params.name || !params.command) {
            return { ok: false, error: 'op "start" requires "name" and "command" parameters.' };
         }
         const supervisor = yield* ProcessSupervisor;
         const proc = yield* supervisor.start({
            name: params.name,
            command: params.command,
            cwd: params.cwd,
            env: params.env,
            ready: params.ready
         });
         return { ok: true, process: proc };
      }

      case "ps": {
         const supervisor = yield* ProcessSupervisor;
         const processes = yield* supervisor.ps;
         return { ok: true, processes };
      }

      case "logs": {
         if (!params.name) {
            return { ok: false, error: 'op "logs" requires "name" parameter.' };
         }
         const supervisor = yield* ProcessSupervisor;
         const logRes = yield* supervisor.logs(params.name, {
            lines: params.lines,
            grep: params.grep
         });
         return { ok: true, lines: logRes.lines, cursor: logRes.cursor };
      }

      case "stop": {
         if (!params.name) {
            return { ok: false, error: 'op "stop" requires "name" parameter.' };
         }
         const supervisor = yield* ProcessSupervisor;
         const proc = yield* supervisor.stop(params.name, params.signal as NodeJS.Signals | undefined);
         return { ok: true, process: proc };
      }

      case "restart": {
         if (!params.name) {
            return { ok: false, error: 'op "restart" requires "name" parameter.' };
         }
         const supervisor = yield* ProcessSupervisor;
         const proc = yield* supervisor.restart(params.name);
         return { ok: true, process: proc };
      }

      case "describe": {
         if (params.id) {
            const registry = yield* JobRegistry;
            const job = yield* registry.get(params.id);
            if (!job) {
               return { ok: false, error: `Job "${params.id}" not found.` };
            }
            return { ok: true, job };
         }
         if (params.name) {
            const supervisor = yield* ProcessSupervisor;
            const processes = yield* supervisor.ps;
            const proc = processes.find((p) => p.name === params.name);
            if (!proc) {
               return { ok: false, error: `Process "${params.name}" not found.` };
            }
            return { ok: true, process: proc };
         }
         return { ok: false, error: 'op "describe" requires "id" or "name".' };
      }

      case "send":
      case "inbox":
      case "list":
      case "wait-from": {
         return { ok: false, error: `Messaging operation "${params.op}" is not implemented until Phase 2a MailBus.` };
      }

      default:
         return { ok: false, error: `Unknown op "${(params as any).op}".` };
   }
});
