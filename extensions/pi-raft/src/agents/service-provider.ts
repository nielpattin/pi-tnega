import type { RaftProvider } from "../protocol.js";
import { AgentService } from "./service.js";
import { agentServiceArgs, agentServiceDescriptors } from "./service-schema.js";
import type {
  AgentServiceAction,
  AgentServiceClient,
  AgentServiceDispatcher,
  AgentPublicRecord,
  AgentServiceLogPage,
  AgentServiceRequest,
} from "./service-types.js";

/** Bind only authenticated host identity here. Guest arguments never carry the caller. */
export function createAgentServiceHandler(
  service: AgentService,
  callerId: string,
): AgentServiceDispatcher {
  return async (action, input, signal) => {
    const args = agentServiceArgs(action, input);
    switch (action) {
      case "run":
        return service.run(callerId, args as unknown as AgentServiceRequest, signal);
      case "spawn":
        return service.spawn(callerId, args as unknown as AgentServiceRequest, signal);
      case "wait":
        return service.wait(callerId, args.id as string, signal);
      case "status":
        return service.status(callerId, args.id as string);
      case "list":
        return service.list(callerId);
      case "stop":
        return service.stop(callerId, args.id as string);
      case "log":
        return service.log(callerId, args.id as string, {
          ...(typeof args.lines === "number" ? { lines: args.lines as number } : {}),
          ...(typeof args.before === "number" ? { before: args.before as number } : {}),
        });
      default:
        throw new Error(`Unsupported hosted agents action: ${String(action)}`);
    }
  };
}

/** A transport client only; all admission and lifecycle remain in the root service. */
export function createAgentServiceClient(dispatch: AgentServiceDispatcher): AgentServiceClient {
  const record = (
    action: AgentServiceAction,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => dispatch(action, args, signal) as Promise<AgentPublicRecord>;
  return {
    dispatch,
    run: (request, signal) => record("run", request as unknown as Record<string, unknown>, signal),
    spawn: (request, signal) =>
      record("spawn", request as unknown as Record<string, unknown>, signal),
    wait: (id, signal) => record("wait", { id }, signal),
    status: (id) => record("status", { id }),
    list: () => dispatch("list", {}) as Promise<AgentPublicRecord[]>,
    stop: (id) => record("stop", { id }),
    log: (id, opts) => record("log", { id, ...opts }) as unknown as Promise<AgentServiceLogPage>,
  };
}

export function createAgentsProvider(client: AgentServiceClient): RaftProvider {
  const descriptors = agentServiceDescriptors();
  const allowed = new Set(descriptors.map((descriptor) => descriptor.name));
  const validate = (action: string, args: Record<string, unknown>) => {
    if (!allowed.has(action)) throw new Error(`Unsupported hosted agents action: ${action}`);
    return agentServiceArgs(action as AgentServiceAction, args);
  };
  return {
    name: "agents",
    description: "Raft host-authorized Pi agents",
    list: async () => structuredClone(descriptors),
    describe: async (name) =>
      structuredClone(descriptors.find((descriptor) => descriptor.name === name)),
    prepareArguments: (action, args) => validate(action, args),
    invoke: async (action, args, context) =>
      client.dispatch(action as AgentServiceAction, validate(action, args), context.signal),
  };
}
