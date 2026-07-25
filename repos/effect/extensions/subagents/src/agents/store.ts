import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGY_MODEL } from "../backends/agy.ts";
import type { AgentProfile, AgentsConfig, ProfileName } from "./types.ts";

export function createDefaultProfile(): AgentProfile {
   return {
      harness: "pi",
      pi: { model: null, reasoning_effort: null },
      agy: { model: DEFAULT_AGY_MODEL, reasoning_effort: "low" }
   };
}

export function createDefaultConfig(): AgentsConfig {
   return {
      version: 1,
      profiles: {
         fast: createDefaultProfile(),
         good: createDefaultProfile()
      }
   };
}

export function getAgentsConfigPath(agentDir: string = getAgentDir()): string {
   return path.join(agentDir, "agents.json");
}

export function loadAgentsConfig(configPath?: string): AgentsConfig {
   const filePath = configPath ?? getAgentsConfigPath();
   try {
      if (!fs.existsSync(filePath)) {
         return createDefaultConfig();
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const defaults = createDefaultConfig();

      const result: AgentsConfig = {
         version: 1,
         profiles: {
            fast: parseProfile(parsed?.profiles?.fast, defaults.profiles.fast),
            good: parseProfile(parsed?.profiles?.good, defaults.profiles.good)
         }
      };
      return result;
   } catch {
      return createDefaultConfig();
   }
}

function parseProfile(rawProfile: any, fallback: AgentProfile): AgentProfile {
   if (!rawProfile || typeof rawProfile !== "object") {
      return fallback;
   }

   const harness = rawProfile.harness === "agy" ? "agy" : "pi";
   const piModel = typeof rawProfile.pi?.model === "string" ? rawProfile.pi.model : null;
   const piEffort = typeof rawProfile.pi?.reasoning_effort === "string" ? rawProfile.pi.reasoning_effort : null;

   const agyModel = typeof rawProfile.agy?.model === "string" ? rawProfile.agy.model : fallback.agy.model;
   const agyEffort =
      rawProfile.agy?.reasoning_effort === "medium" ||
      rawProfile.agy?.reasoning_effort === "high" ||
      rawProfile.agy?.reasoning_effort === "low"
         ? rawProfile.agy.reasoning_effort
         : fallback.agy.reasoning_effort;

   const parseTools = (raw: any): string[] | undefined => {
      if (Array.isArray(raw)) return raw.filter((t) => typeof t === "string");
      if (typeof raw === "string" && raw.trim())
         return raw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
      return undefined;
   };

   const parseBody = (raw: any): string | undefined => {
      return typeof raw === "string" && raw.trim() ? raw : undefined;
   };

   const topTools = parseTools(rawProfile.tools);
   const topBody = parseBody(rawProfile.body);

   const piTools = parseTools(rawProfile.pi?.tools) ?? topTools;
   const piBody = parseBody(rawProfile.pi?.body) ?? topBody;
   const agyBody = parseBody(rawProfile.agy?.body) ?? topBody;

   return {
      harness,
      pi: {
         model: piModel,
         reasoning_effort: piEffort as any,
         tools: piTools,
         body: piBody
      },
      agy: {
         model: agyModel,
         reasoning_effort: agyEffort,
         body: agyBody
      },
      tools: topTools,
      body: topBody
   };
}

export function saveAgentsConfig(config: AgentsConfig, configPath?: string): void {
   const filePath = configPath ?? getAgentsConfigPath();
   const dir = path.dirname(filePath);
   if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
   }
   fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

export function switchHarness(profile: AgentProfile, targetHarness: "pi" | "agy"): AgentProfile {
   if (profile.harness === targetHarness) {
      return profile;
   }

   if (targetHarness === "agy") {
      const agy = profile.agy ?? {
         model: DEFAULT_AGY_MODEL,
         reasoning_effort: "low"
      };
      return {
         ...profile,
         harness: "agy",
         agy: {
            model: agy.model || DEFAULT_AGY_MODEL,
            reasoning_effort: agy.reasoning_effort || "low"
         }
      };
   } else {
      const pi = profile.pi ?? { model: null, reasoning_effort: null };
      return {
         ...profile,
         harness: "pi",
         pi
      };
   }
}
