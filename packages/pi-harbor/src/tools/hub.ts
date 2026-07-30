import { Type } from "typebox";
import { Effect } from "effect";
import { JobRegistry } from "../services/JobRegistry.js";
import { ProcessSupervisor } from "../services/ProcessSupervisor.js";
import { ShellExecutor } from "../services/ShellExecutor.js";
import { MailBus } from "../services/MailBus.js";

const TimeoutMsSchema = Type.Optional(Type.Number({ description: "Maximum blocking time in milliseconds." }));
const ProcessNameSchema = Type.String({
   description: "Supervised OS process name, for example api. Not a task job ID."
});
const JobIdSchema = Type.String({ description: "Agent job ID returned by task, for example task-1." });
const PeerIdSchema = Type.String({ description: "Mailbox peer ID." });
const EnvironmentSchema = Type.Optional(
   Type.Record(Type.String(), Type.String(), { description: "Environment variables added to the command." })
);

const JobsOperationSchema = Type.Object({
   op: Type.Literal("jobs", { description: "List all tracked agent jobs." })
});
const WaitJobsOperationSchema = Type.Object({
   op: Type.Literal("wait", { description: "Wait for one or more resources." }),
   target: Type.Literal("jobs", { description: "Wait for agent jobs." }),
   ids: Type.Array(JobIdSchema, { minItems: 1, description: "Exact agent job IDs to wait for." }),
   timeoutMs: TimeoutMsSchema
});
const WaitProcessOperationSchema = Type.Object({
   op: Type.Literal("wait", { description: "Wait for one or more resources." }),
   target: Type.Literal("process", { description: "Wait for a supervised OS process." }),
   name: ProcessNameSchema,
   timeoutMs: TimeoutMsSchema
});
const WaitMessageOperationSchema = Type.Object({
   op: Type.Literal("wait", { description: "Wait for one or more resources." }),
   target: Type.Literal("message", { description: "Wait for a mailbox message." }),
   from: PeerIdSchema,
   to: Type.Optional(PeerIdSchema),
   timeoutMs: TimeoutMsSchema
});
const CancelOperationSchema = Type.Object({
   op: Type.Literal("cancel", { description: "Cancel one agent job." }),
   id: JobIdSchema
});
const ExecOperationSchema = Type.Object({
   op: Type.Literal("exec", { description: "Execute a shell command." }),
   command: Type.String({ description: "Shell command to execute." }),
   cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session directory." })),
   env: EnvironmentSchema,
   async: Type.Optional(Type.Boolean({ description: "Start a retained process instead of waiting for completion." })),
   timeoutMs: TimeoutMsSchema,
   name: Type.Optional(ProcessNameSchema)
});
const WorkerExecOperationSchema = Type.Object({
   op: Type.Literal("exec", { description: "Execute a synchronous shell command." }),
   command: Type.String({ description: "Shell command to execute synchronously." }),
   cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the worker directory." })),
   env: EnvironmentSchema,
   timeoutMs: TimeoutMsSchema
});
const StartOperationSchema = Type.Object({
   op: Type.Literal("start", { description: "Start and retain a named OS process." }),
   name: ProcessNameSchema,
   command: Type.String({ description: "Shell command used to start the process." }),
   cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session directory." })),
   env: EnvironmentSchema,
   ready: Type.Optional(
      Type.Object(
         {
            log: Type.Optional(Type.String({ description: "Log text that marks the process ready." })),
            port: Type.Optional(Type.Number({ description: "TCP port that marks the process ready." })),
            timeoutSec: Type.Optional(Type.Number({ description: "Readiness timeout in seconds." }))
         },
         { description: "Optional process readiness condition." }
      )
   )
});
const PsOperationSchema = Type.Object({
   op: Type.Literal("ps", { description: "List supervised OS processes." })
});
const LogsOperationSchema = Type.Object({
   op: Type.Literal("logs", { description: "Read retained logs for a supervised OS process." }),
   name: ProcessNameSchema,
   lines: Type.Optional(Type.Number({ description: "Maximum number of trailing lines." })),
   grep: Type.Optional(Type.String({ description: "Filter log lines by this text or pattern." }))
});
const StopOperationSchema = Type.Object({
   op: Type.Literal("stop", { description: "Stop a supervised OS process." }),
   name: ProcessNameSchema,
   signal: Type.Optional(
      Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL")], {
         description: "Signal used to stop the process."
      })
   )
});
const RestartOperationSchema = Type.Object({
   op: Type.Literal("restart", { description: "Restart a supervised OS process." }),
   name: ProcessNameSchema
});
const DescribeJobOperationSchema = Type.Object({
   op: Type.Literal("describe", { description: "Inspect one agent job or supervised process." }),
   id: JobIdSchema
});
const DescribeProcessOperationSchema = Type.Object({
   op: Type.Literal("describe", { description: "Inspect one agent job or supervised process." }),
   name: ProcessNameSchema
});
const SendOperationSchema = Type.Object({
   op: Type.Literal("send", { description: "Send a mailbox message to one peer." }),
   to: PeerIdSchema,
   message: Type.String({ description: "Message payload." }),
   from: Type.Optional(PeerIdSchema),
   replyTo: Type.Optional(Type.String({ description: "Message ID this message replies to." }))
});
const InboxOperationSchema = Type.Object({
   op: Type.Literal("inbox", { description: "Read queued mailbox messages." }),
   to: Type.Optional(PeerIdSchema),
   from: Type.Optional(PeerIdSchema),
   peek: Type.Optional(Type.Boolean({ description: "Keep returned messages unconsumed." }))
});
const ListOperationSchema = Type.Object({
   op: Type.Literal("list", { description: "List mailbox peers. This does not list jobs or processes." })
});
const WaitFromOperationSchema = Type.Object({
   op: Type.Literal("wait-from", { description: "Wait for a mailbox message from one peer." }),
   from: PeerIdSchema,
   to: Type.Optional(PeerIdSchema),
   timeoutMs: TimeoutMsSchema
});

/** Provider-facing schema for the full parent Hub tool. */
export const ParentHubToolParamsSchema = Type.Union(
   [
      JobsOperationSchema,
      WaitJobsOperationSchema,
      WaitProcessOperationSchema,
      WaitMessageOperationSchema,
      CancelOperationSchema,
      ExecOperationSchema,
      StartOperationSchema,
      PsOperationSchema,
      LogsOperationSchema,
      StopOperationSchema,
      RestartOperationSchema,
      DescribeJobOperationSchema,
      DescribeProcessOperationSchema,
      SendOperationSchema,
      InboxOperationSchema,
      ListOperationSchema,
      WaitFromOperationSchema
   ],
   { type: "object" }
);

/** Provider-facing schema restricted to operations available inside Pi workers. */
export const WorkerHubToolParamsSchema = Type.Union(
   [WorkerExecOperationSchema, SendOperationSchema, InboxOperationSchema, ListOperationSchema, WaitFromOperationSchema],
   { type: "object" }
);

/** Backward-compatible name for the parent Hub parameter schema. */
export const HubToolParamsSchema = ParentHubToolParamsSchema;

/**
 * Runtime Hub input after Pi schema validation.
 *
 * Fields remain optional here because renderers receive partial streaming arguments
 * and compatibility tests call the handler directly to verify actionable errors.
 * The registered parent and worker schemas enforce operation-specific required fields.
 */
export interface HubToolParams {
   readonly op:
      | "jobs"
      | "wait"
      | "cancel"
      | "exec"
      | "start"
      | "ps"
      | "logs"
      | "stop"
      | "restart"
      | "describe"
      | "send"
      | "inbox"
      | "list"
      | "wait-from";
   readonly target?: "jobs" | "process" | "message";
   readonly ids?: string[];
   readonly id?: string;
   readonly name?: string;
   readonly command?: string;
   readonly cwd?: string;
   readonly env?: Record<string, string>;
   readonly async?: boolean;
   readonly timeoutMs?: number;
   readonly signal?: "SIGTERM" | "SIGKILL";
   readonly ready?: { readonly log?: string; readonly port?: number; readonly timeoutSec?: number };
   readonly to?: string;
   readonly from?: string;
   readonly message?: string;
   readonly replyTo?: string;
   readonly peek?: boolean;
   readonly lines?: number;
   readonly grep?: string;
}

export const hubToolDefinition = {
   name: "hub",
   description: "Unified hub tool for job monitoring, process supervision, shell execution, and messaging.",
   parameters: HubToolParamsSchema
};

export interface HandleHubOptions {
   isWorker?: boolean;
   harness?: "pi" | "agy";
}

export const handleHub = Effect.fn("hub.handleHub")(function* (params: HubToolParams, options?: HandleHubOptions) {
   if (options?.harness === "agy" && ["send", "inbox", "list", "wait-from"].includes(params.op)) {
      return { ok: false, error: "Inter-agent messaging operations are unsupported on agy harness processes." };
   }

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
            if (!params.from) {
               return { ok: false, error: 'op "wait" for target "message" requires "from" parameter.' };
            }
            const mailBus = yield* MailBus;
            const msg = yield* mailBus.awaitFrom(params.to ?? "parent", params.from, params.timeoutMs);
            return { ok: true, message: msg };
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

      case "send": {
         if (!params.to || !params.message) {
            return { ok: false, error: 'op "send" requires "to" and "message" parameters.' };
         }
         const mailBus = yield* MailBus;
         const msg = yield* mailBus.send({
            senderId: params.from ?? "parent",
            recipientId: params.to,
            payload: params.message,
            replyTo: params.replyTo
         });
         return { ok: true, message: msg };
      }

      case "inbox": {
         const mailBus = yield* MailBus;
         const recipientId = params.from ?? params.to ?? "parent";
         const messages = yield* mailBus.inbox(recipientId, { peek: params.peek });
         return { ok: true, messages };
      }

      case "list": {
         const mailBus = yield* MailBus;
         const peers = yield* mailBus.listPeers;
         return { ok: true, peers };
      }

      case "wait-from": {
         if (!params.from) {
            return { ok: false, error: 'op "wait-from" requires "from" parameter.' };
         }
         const mailBus = yield* MailBus;
         const recipientId = params.to ?? "parent";
         const msg = yield* mailBus.awaitFrom(recipientId, params.from, params.timeoutMs);
         return { ok: true, message: msg };
      }

      default:
         return { ok: false, error: `Unknown op "${(params as any).op}".` };
   }
});
