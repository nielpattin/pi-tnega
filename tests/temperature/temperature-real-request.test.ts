import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const RUN_REAL_TEMPERATURE_TESTS = process.env["RUN_REAL_TEMPERATURE_TESTS"] === "1";
const MODEL = process.env["PI_TEMPERATURE_TEST_MODEL"] ?? "opencode-go/deepseek-v4-flash";
const PI_CLI = process.env["PI_CLI_PATH"] ?? resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const CLI_EXTENSION = resolve("tests/temperature/temperature-cli-extension.ts");
const PROMPT = `You are performing an ISO/IEC/IEEE 29119-style software test design review.

Analyze this requirement:
"When a user resets a password, the system sends a one-time reset link that expires after 15 minutes. A reset link can be used only once. After three failed reset attempts for the same account within 10 minutes, further reset attempts are blocked for 30 minutes."

Return ONLY valid minified JSON. No markdown. No prose.
Schema:
{"risk_summary":string,"boundary_tests":[string,string,string],"negative_tests":[string,string,string],"security_invariants":[string,string,string],"priority":"high"}

Validation rules:
- Every array must contain exactly three non-empty strings.
- Include explicit coverage for 15 minutes, one-time use, and three failed attempts within 10 minutes.
- priority must be "high".`;

type TemperatureLabel = "original" | "0.2" | "0.5" | "1";

type TemperatureLog = {
   label: TemperatureLabel;
   model: string;
   originalTemperature?: unknown;
   sentTemperature?: unknown;
};

type TestDesignResponse = {
   risk_summary: string;
   boundary_tests: [string, string, string];
   negative_tests: [string, string, string];
   security_invariants: [string, string, string];
   priority: "high";
};

const tempDirs: string[] = [];

function parseJsonObject(stdout: string): unknown {
   const trimmed = stdout.trim();
   try {
      return JSON.parse(trimmed);
   } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) throw new Error(`No JSON object in output:\n${stdout}`);
      return JSON.parse(trimmed.slice(start, end + 1));
   }
}

function assertStringArray(value: unknown, field: string): asserts value is [string, string, string] {
   expect(Array.isArray(value), field).toBe(true);
   expect(value, field).toHaveLength(3);
   for (const item of value as unknown[]) {
      expect(typeof item, field).toBe("string");
      expect((item as string).trim().length, field).toBeGreaterThan(0);
   }
}

function assertIndustryStandardResponse(value: unknown): asserts value is TestDesignResponse {
   expect(value && typeof value === "object").toBe(true);
   const response = value as Record<string, unknown>;

   expect(typeof response.risk_summary).toBe("string");
   expect((response.risk_summary as string).trim().length).toBeGreaterThan(0);
   assertStringArray(response.boundary_tests, "boundary_tests");
   assertStringArray(response.negative_tests, "negative_tests");
   assertStringArray(response.security_invariants, "security_invariants");
   expect(response.priority).toBe("high");

   const combined = JSON.stringify(response).toLowerCase();
   expect(combined).toContain("15");
   expect(combined.includes("one-time") || combined.includes("single-use") || combined.includes("single use") || combined.includes("only once") || combined.includes("reuse")).toBe(true);
   expect(combined.includes("three") || combined.includes("3")).toBe(true);
   expect(combined).toContain("10");
}

async function runPi(label: TemperatureLabel, sessionDir: string, logFile: string) {
   const env = {
      ...process.env,
      PI_TEMPERATURE_LABEL: label,
      PI_TEMPERATURE_OVERRIDE: label,
      PI_TEMPERATURE_LOG: logFile,
   };

   const args = [
      PI_CLI,
      "--print",
      "--model",
      MODEL,
      "--session-dir",
      sessionDir,
      "--no-extensions",
      "--extension",
      CLI_EXTENSION,
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      "--no-tools",
      PROMPT,
   ];

   const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolveProcess, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      const timeout = setTimeout(() => {
         child.kill("SIGTERM");
         reject(new Error(`pi timed out for temperature ${label}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 180_000);

      child.stdout.on("data", (chunk: Buffer) => {
         stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
         stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
         clearTimeout(timeout);
         reject(error);
      });
      child.on("close", (exitCode) => {
         clearTimeout(timeout);
         resolveProcess({ exitCode, stdout, stderr });
      });
   });

   expect(result.exitCode, result.stdout + result.stderr).toBe(0);
   return result.stdout;
}

describe.skipIf(!RUN_REAL_TEMPERATURE_TESTS)("pi CLI real provider temperature requests", () => {
   afterAll(async () => {
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
   });

   test("sends same industry-standard prompt with original, 0.2, 0.5, and 1 temperatures", async () => {
      const workDir = await mkdtemp(join(tmpdir(), "pi-temperature-real-"));
      tempDirs.push(workDir);
      const sessionDir = join(workDir, "sessions");
      const logFile = join(workDir, "temperature.jsonl");

      const labels: TemperatureLabel[] = ["original", "0.2", "0.5", "1"];
      const outputs: Array<readonly [TemperatureLabel, string]> = [];
      for (const label of labels) {
         outputs.push([label, await runPi(label, sessionDir, logFile)] as const);
      }

      for (const [label, stdout] of outputs) {
         const parsed = parseJsonObject(stdout);
         assertIndustryStandardResponse(parsed);
         expect(JSON.stringify(parsed), label).toContain("high");
      }

      const logs = (await readFile(logFile, "utf8"))
         .trim()
         .split(/\r?\n/)
         .filter(Boolean)
         .map((line) => JSON.parse(line) as TemperatureLog);

      expect(logs.map((entry) => entry.label)).toEqual(labels);
      expect(logs.every((entry) => entry.model === MODEL)).toBe(true);
      expect(logs[0]?.sentTemperature).toBe(logs[0]?.originalTemperature);
      expect(logs[1]?.sentTemperature).toBe(0.2);
      expect(logs[2]?.sentTemperature).toBe(0.5);
      expect(logs[3]?.sentTemperature).toBe(1);
   }, 720_000);
});
