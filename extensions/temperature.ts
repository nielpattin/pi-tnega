import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_TEMPERATURE = 0.2;
const STATUS_KEY = "temperature";
const ORIGINAL = "original";
const TEMPERATURE_OPTIONS = [
   ORIGINAL,
   "0",
   "0.1",
   "0.2",
   "0.3",
   "0.4",
   "0.5",
   "0.6",
   "0.7",
   "0.8",
   "0.9",
   "1"
] as const;

type TemperatureSetting = number | typeof ORIGINAL;

interface TemperatureState {
   model: string;
   originalTemperature: unknown;
   sentTemperature: unknown;
   setting: TemperatureSetting;
}

function formatTemperature(value: unknown): string {
   if (value === undefined) return "not set";
   if (value === null) return "null";
   return String(value);
}

function getModelName(ctx: ExtensionContext): string {
   return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
}

function parseTemperatureSetting(value: string): TemperatureSetting {
   if (value === ORIGINAL) return ORIGINAL;
   return Number(value);
}

function getSentTemperature(setting: TemperatureSetting, originalTemperature: unknown): unknown {
   return setting === ORIGINAL ? originalTemperature : setting;
}

function updateStatus(ctx: ExtensionContext, setting: TemperatureSetting) {
   if (!ctx.hasUI) return;
   ctx.ui.setStatus(STATUS_KEY, `temper: ${formatTemperature(setting)}`);
}

function formatMessage(state: TemperatureState): string {
   return `temperature sent ${formatTemperature(state.sentTemperature)} · setting ${formatTemperature(state.setting)} · original ${formatTemperature(state.originalTemperature)} · model ${state.model}`;
}

export default function temperatureExtension(pi: ExtensionAPI) {
   const requests: TemperatureState[] = [];
   let setting: TemperatureSetting = DEFAULT_TEMPERATURE;

   pi.registerCommand("temperature", {
      description: "Select provider temperature",
      handler: async (_args, ctx) => {
         const options = TEMPERATURE_OPTIONS.map(String);
         const currentOption = formatTemperature(setting);
         const temperature = await ctx.ui.select(
            "Select temperature",
            options.includes(currentOption)
               ? [currentOption, ...options.filter((item) => item !== currentOption)]
               : options
         );
         if (!temperature) return;

         setting = parseTemperatureSetting(temperature);
         updateStatus(ctx, setting);
         ctx.ui.notify(`temperature: ${formatTemperature(setting)}`, "info");
      }
   });

   pi.on("session_start", (_event, ctx) => {
      updateStatus(ctx, setting);
   });

   pi.on("model_select", (_event, ctx) => {
      updateStatus(ctx, setting);
   });

   pi.on("before_agent_start", (_event, ctx) => {
      requests.length = 0;
      updateStatus(ctx, setting);
   });

   pi.on("before_provider_request", (event, ctx) => {
      const model = getModelName(ctx);
      const payload = event.payload as Record<string, unknown>;
      const originalTemperature = payload.temperature;
      const sentTemperature = getSentTemperature(setting, originalTemperature);

      requests.push({
         model,
         originalTemperature,
         sentTemperature,
         setting
      });

      updateStatus(ctx, setting);

      if (setting === ORIGINAL) return;

      return {
         ...payload,
         temperature: setting
      };
   });

   pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
      setTimeout(() => {
         if (requests.length === 0) return;

         const last = requests[requests.length - 1];
         requests.length = 0;

         updateStatus(ctx, last.setting);
         if (ctx.hasUI) ctx.ui.notify(formatMessage(last), "info");
      }, 0);
   });
}
