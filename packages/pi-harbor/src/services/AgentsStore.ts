import { Context, Effect, Layer } from "effect";
import type { AgentDefinition, HarnessName } from "../domain.js";

export interface VibeProfileConfig {
   harness: HarnessName;
   pi?: {
      model?: string;
      reasoning_effort?: string;
      tools?: string[];
   };
   agy?: {
      model?: string;
      reasoning_effort?: string;
   };
}

export interface AgentsStoreShape {
   readonly getAgent: (name: string) => Effect.Effect<AgentDefinition | undefined>;
   readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>;
   readonly getVibeProfiles: () => Effect.Effect<{ fast: VibeProfileConfig; good: VibeProfileConfig }>;
}

const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
   scout: {
      name: "scout",
      display_name: "scout",
      description: "Read-only codebase research agent for rapid exploration and analysis.",
      tools: ["read", "grep", "find", "web_search_exa"],
      guidance: "Read-only research scout returning compressed context.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: `# SCOUT AGENT\n\nInvestigate codebase rapidly. Return structured findings.`
   },
   task: {
      name: "task",
      display_name: "task",
      description: "General-purpose worker for delegated implementation tasks with full tool access.",
      tools: ["read", "write", "edit", "grep", "find", "hub"],
      guidance: "Use for delegated implementation work that needs full tools.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: `# TASK AGENT\n\nYou are an implementation worker agent for delegated coding tasks.`
   },
   "high-task": {
      name: "high-task",
      display_name: "high-task",
      description: "Specialized worker for complex delegated implementation tasks requiring multi-step planning.",
      tools: ["read", "write", "edit", "grep", "find", "hub"],
      guidance: "High-capability worker for complex multi-file refactors.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: `# HIGH-TASK AGENT\n\nYou are a specialized worker for hard implementation challenges.`
   },
   reviewer: {
      name: "reviewer",
      display_name: "reviewer",
      description: "Code review agent that evaluates git changes and PR diffs.",
      tools: ["read", "hub"],
      guidance: "Review agent evaluating code diffs and safety boundaries.",
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: `# REVIEWER AGENT\n\nEvaluate code changes and pull request diffs.`
   }
};

const DEFAULT_VIBE_PROFILES: { fast: VibeProfileConfig; good: VibeProfileConfig } = {
   fast: {
      harness: "pi",
      pi: {
         model: "proxy/cfai/@cf/moonshotai/kimi-k2.7-code",
         reasoning_effort: "low",
         tools: ["read", "write", "edit", "grep", "find"]
      },
      agy: {
         model: "gemini-3.6-flash-medium",
         reasoning_effort: "low"
      }
   },
   good: {
      harness: "pi",
      pi: {
         model: "cpit/gpt-5.6-sol",
         reasoning_effort: "high",
         tools: ["read", "write", "edit", "grep", "find", "hub"]
      },
      agy: {
         model: "gemini-3.6-flash-medium",
         reasoning_effort: "high"
      }
   }
};

export class AgentsStore extends Context.Service<AgentsStore, AgentsStoreShape>()("harbor/AgentsStore") {
   static readonly layer = Layer.effect(
      AgentsStore,
      Effect.sync(() => {
         const getAgent = Effect.fn("AgentsStore.getAgent")(function* (name: string) {
            return yield* Effect.succeed(BUILTIN_AGENTS[name] as AgentDefinition | undefined);
         });

         const listAgents = Effect.fn("AgentsStore.listAgents")(function* () {
            return yield* Effect.succeed(Object.values(BUILTIN_AGENTS));
         });

         const getVibeProfiles = Effect.fn("AgentsStore.getVibeProfiles")(function* () {
            return yield* Effect.succeed(DEFAULT_VIBE_PROFILES);
         });

         return AgentsStore.of({
            getAgent,
            listAgents,
            getVibeProfiles
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: AgentsStoreShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | AgentsStore> {
      return Effect.gen(function* () {
         const svc = yield* AgentsStore;
         return yield* fn(svc);
      });
   }
}
