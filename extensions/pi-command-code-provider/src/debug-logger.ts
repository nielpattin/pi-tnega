import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEYS =
   /api[_-]?key|authorization|(?:^|[_-])(?:access|auth|bearer|id|oauth|refresh)?[_-]?token(?:$|[_-])|secret|password/i;

export interface DebugLoggerOptions {
   extensionRoot: string;
   debug: boolean;
}

function redactSecrets(value: unknown): unknown {
   if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
   if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
         output[key] = SECRET_KEYS.test(key) ? "[REDACTED]" : redactSecrets(nestedValue);
      }
      return output;
   }
   return value;
}

function stringifyDetails(details: unknown): string {
   if (details === undefined) return "";
   try {
      return ` ${JSON.stringify(redactSecrets(details))}`;
   } catch {
      return " [unserializable-details]";
   }
}

export class DebugLogger {
   private readonly options: DebugLoggerOptions;
   private readonly debugDir: string;
   private readonly logPath: string;
   private readonly trafficLogPath: string;
   private debugDirEnsured = false;

   constructor(options: DebugLoggerOptions) {
      this.options = options;
      this.debugDir = join(options.extensionRoot, "debug");
      this.logPath = join(this.debugDir, "debug.log");
      this.trafficLogPath = join(this.debugDir, "provider-traffic.log");
   }

   debug(event: string, details?: unknown): void {
      this.write("debug", event, details);
   }

   warn(event: string, details?: unknown): void {
      this.write("warn", event, details);
   }

   error(event: string, details?: unknown): void {
      this.write("error", event, details);
   }

   trace(event: string, details?: unknown): void {
      this.writeTraffic(event, details);
   }

   private ensureDebugDir(): void {
      if (this.debugDirEnsured) return;
      if (!existsSync(this.debugDir)) {
         mkdirSync(this.debugDir, { recursive: true });
      }
      this.debugDirEnsured = true;
   }

   private write(level: "debug" | "warn" | "error", event: string, details?: unknown): void {
      if (!this.options.debug) return;
      try {
         this.ensureDebugDir();
         const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, extension: "pi-command-code-provider", event })}${stringifyDetails(details)}\n`;
         appendFileSync(this.logPath, line, "utf-8");
      } catch {
         // Debug logging must never affect provider behavior or terminal output.
      }
   }

   private writeTraffic(event: string, details?: unknown): void {
      try {
         this.ensureDebugDir();
         const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level: "trace", extension: "pi-command-code-provider", event })}${stringifyDetails(details)}\n`;
         appendFileSync(this.trafficLogPath, line, "utf-8");
      } catch {
         // Traffic logging must never affect provider behavior or terminal output.
      }
   }
}
