import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function parseTemperature(value: string | undefined): number | undefined {
   if (!value || value === "original") return undefined;
   const temperature = Number(value);
   if (!Number.isFinite(temperature)) throw new Error(`Invalid PI_TEMPERATURE_OVERRIDE: ${value}`);
   return temperature;
}

export default function temperatureCliExtension(pi: ExtensionAPI) {
   pi.on("before_provider_request", (event, ctx) => {
      const logFile = process.env["PI_TEMPERATURE_LOG"];
      if (!logFile) throw new Error("PI_TEMPERATURE_LOG must be set");

      const payload = event.payload as Record<string, unknown>;
      const override = parseTemperature(process.env["PI_TEMPERATURE_OVERRIDE"]);
      const nextPayload = override === undefined ? payload : { ...payload, temperature: override };

      appendFileSync(
         logFile,
         `${JSON.stringify({
            label: process.env["PI_TEMPERATURE_LABEL"] ?? "unknown",
            model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
            originalTemperature: payload.temperature,
            sentTemperature: (nextPayload as Record<string, unknown>).temperature,
         })}\n`,
         "utf8",
      );

      if (override === undefined) return;
      return nextPayload;
   });
}
