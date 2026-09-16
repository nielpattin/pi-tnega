import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_RAFT_CONFIG } from "../src/config.js";
import { effectiveAgentTimeoutMs, AgentManager } from "../src/agents/manager.js";
import { clearOwnedBudgetEnv, readBudgetLedgerDetailed } from "../src/agents/budget-ledger.js";
import type { AgentRunRecord, AgentRunResult } from "../src/agents/types.js";

const managers: AgentManager[] = [];
const roots: string[] = [];
type RaftSurfaceResult = AgentRunResult & {
  tools?: string[];
  extensions?: string;
  raftExtension?: string;
  toolAllowlistEnv?: string[];
  grantedRisks?: string[];
};
const raftEnvKeys = [
  "PI_RAFT_DEPTH",
  "PI_RAFT_BUDGET",
  "PI_RAFT_BUDGET_FILE",
  "PI_RAFT_BUDGET_ID",
] as const;
const inheritedRaftEnv = new Map(raftEnvKeys.map((key) => [key, process.env[key]]));

beforeAll(() => {
  for (const key of raftEnvKeys) delete process.env[key];
});

afterAll(() => {
  for (const [key, value] of inheritedRaftEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("effectiveAgentTimeoutMs", () => {
  it("ignores per-call timeouts below the configured default", () => {
    expect(effectiveAgentTimeoutMs(3_600_000, 240_000)).toBe(3_600_000);
  });

  it("accepts per-call timeouts above the configured default", () => {
    expect(effectiveAgentTimeoutMs(3_600_000, 7_200_000)).toBe(7_200_000);
  });

  it("respects a configured default below 60 minutes", () => {
    expect(effectiveAgentTimeoutMs(1_800_000, 900_000)).toBe(1_800_000);
    expect(effectiveAgentTimeoutMs(1_800_000, 2_400_000)).toBe(2_400_000);
  });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentManager", () => {
  it("notifies and releases UI subscribers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const listener = vi.fn();
    const unsubscribe = manager.subscribeUi(listener);

    const result = await manager.run({ task: "Observe state", transport: "process" });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    const beforeCleanup = listener.mock.calls.length;
    await manager.cleanup(result.id);
    expect(listener).toHaveBeenCalledTimes(beforeCleanup);
  });

  it("defaults the label when the caller omits a name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "In the current repository, edit @README.md by replacing its first line exactly with 1+1=2.",
      transport: "process",
    });
    // The label is caller-supplied or a constant; Raft never crops the task
    // prompt into a name.
    expect(result.name).toBe("Raft agent");
  });

  it("keeps an explicit name verbatim and rejects a blank task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const named = await manager.run({
      name: "README first line",
      task: "do it",
      transport: "process",
    });
    expect(named.name).toBe("README first line");
    // A blank task never reaches naming: lifecycle rejects it first.
    await expect(manager.run({ task: "   ", transport: "process" })).rejects.toThrow(
      /task must not be empty/i,
    );
  });

  it("runs a worker through the direct process transport", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect this repository", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.text).toBe("fake worker complete");
    expect(result.transport).toBe("process");
    expect(manager.list()).toHaveLength(1);
    fs.rmSync(path.join(manager.runDirectory(result.id)!, "status.json"));
    expect(manager.status(result.id).status).toBe("completed");
  });

  it("does not let same-provider preparation authorize a different model", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const preparePiModel = vi.fn(async (model: string | undefined) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (model === "openai-codex/gpt-hidden") {
        throw new Error(`Model ${JSON.stringify(model)} is not available to this Pi session`);
      }
      return model;
    });
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      preparePiModel,
    });
    managers.push(manager);

    const [visible, hidden] = await Promise.allSettled([
      manager.run({
        task: "Visible prepared child",
        model: "openai-codex/gpt-visible",
        transport: "process",
      }),
      manager.run({
        task: "Hidden prepared child",
        model: "openai-codex/gpt-hidden",
        transport: "process",
      }),
    ]);

    expect(visible).toMatchObject({ status: "fulfilled", value: { status: "completed" } });
    expect(hidden).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("not available to this Pi session"),
      }),
    });
    expect(preparePiModel).toHaveBeenCalledTimes(2);
    expect(
      preparePiModel.mock.calls
        .map(([model]) => model)
        .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["openai-codex/gpt-hidden", "openai-codex/gpt-visible"]);
  });

  it("validates the configured Pi model default before launching", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(
      process.cwd(),
      { ...DEFAULT_RAFT_CONFIG.agents, model: "provider/hidden" },
      {
        workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
        runRoot: root,
        preparePiModel: async (model) => {
          throw new Error(`Model ${JSON.stringify(model)} is not available to this Pi session`);
        },
      },
    );
    managers.push(manager);

    await expect(manager.spawn({ task: "Do not launch", runner: "pi" })).rejects.toThrow(
      /not available to this Pi session/,
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("retries a Pi child that fails before its first turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Recover startup", transport: "process" });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("startup retry recovered");
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("2");
  });

  it("does not retry deterministic failures before the first turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Reject startup", transport: "process" });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("provider rejected the prompt");
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("1");
  });

  it("retries a child whose transport exits before producing a result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-transport-death.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Recoverable boot death", transport: "process" });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("transport death retry recovered");
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("2");
  }, 30_000);

  it("gives up retrying a child whose transport always exits before producing a result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-transport-death.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Terminal boot death", transport: "process" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Agent transport exited without a result");
    // AGENT_STARTUP_MAX_ATTEMPTS counts the initial launch: exactly 3 total.
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("3");
  }, 30_000);

  it("keeps full results in the API and compact projections for the dashboard", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "LARGE_RESULT", transport: "process" });
    expect(result.text).toHaveLength(100_000);
    expect((result.value as { output: string }).output).toHaveLength(100_000);

    const records = manager.listForUi();
    const compact = records[0] as AgentRunRecord;
    expect(compact.text.length).toBeLessThanOrEqual(16_001);
    expect(compact.value).toMatchObject({ raftTruncated: true });
    expect(manager.listForUi()).toBe(records);
    expect((manager.status(result.id) as AgentRunRecord).text).toHaveLength(100_000);
    expect((await manager.wait(result.id)).text).toHaveLength(100_000);
  });

  it("readLog returns the run's event stream and status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect this repository", transport: "process" });
    expect(manager.runDirectory(result.id)).toBeDefined();
    const log = manager.readLog(result.id);
    expect(log.id).toBe(result.id);
    expect(log.logFile).toContain("events.jsonl");
    expect(log.runDirectory).toContain(path.basename(root));
    expect(log.status?.status).toBe("completed");
    const types = log.events.map((line) => (line.parsed as { type?: string } | undefined)?.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_end");
    expect(types).toContain("agent_settled");
  });

  it("derives trusted log paths and recursively discovers bounded nested runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect nesting", transport: "process" });
    const runDirectory = manager.runDirectory(result.id)!;
    const topStatus = JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"));
    fs.writeFileSync(
      path.join(runDirectory, "status.json"),
      JSON.stringify({ ...topStatus, logFile: "/tmp/untrusted-top.jsonl" }),
    );
    const childDirectory = path.join(runDirectory, "nested", "child");
    const grandchildDirectory = path.join(childDirectory, "nested", "grandchild");
    fs.mkdirSync(grandchildDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(childDirectory, "status.json"),
      JSON.stringify({
        ...result,
        id: "child",
        name: "child",
        logFile: "/tmp/untrusted-child.jsonl",
      }),
    );
    fs.writeFileSync(
      path.join(grandchildDirectory, "status.json"),
      JSON.stringify({
        ...result,
        id: "grandchild",
        name: "grandchild",
        logFile: "/tmp/untrusted-grandchild.jsonl",
      }),
    );

    const status = manager.status(result.id) as AgentRunRecord;
    expect(status.logFile).toBe(path.join(runDirectory, "events.jsonl"));
    expect(status.nestedAgents?.[0]?.logFile).toBe(path.join(childDirectory, "events.jsonl"));
    expect(status.nestedAgents?.[0]?.nestedAgents?.[0]?.logFile).toBe(
      path.join(grandchildDirectory, "events.jsonl"),
    );

    status.nestedAgents![0]!.name = "caller mutation";
    fs.rmSync(path.join(runDirectory, "nested"), { recursive: true, force: true });
    const retained = manager.status(result.id) as AgentRunRecord;
    expect(retained.nestedAgents?.[0]?.name).toBe("child");
    expect(retained.nestedAgents?.[0]?.nestedAgents?.[0]?.name).toBe("grandchild");
  });

  it("captures recursive leaves before the child process removes their directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({
      task: "HANG while nested agents finish",
      transport: "process",
      recursive: true,
    });
    const runDirectory = manager.runDirectory(handle.id)!;
    const statusFile = path.join(runDirectory, "status.json");
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(statusFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const parentStatus = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    const leafDirectory = path.join(runDirectory, "nested", "finished-leaf");
    fs.mkdirSync(leafDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(leafDirectory, "status.json"),
      JSON.stringify({
        ...parentStatus,
        id: "finished-leaf",
        name: "finished leaf",
        status: "completed",
        finishedAt: Date.now(),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.rmSync(path.join(runDirectory, "nested"), { recursive: true, force: true });
    const retained = manager.status(handle.id) as AgentRunRecord;
    expect(retained.nestedAgents?.[0]).toMatchObject({
      id: "finished-leaf",
      name: "finished leaf",
      status: "completed",
    });
    await manager.stop(handle.id);
  });

  it("keeps explicit extensions:false children native", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const native = (await manager.run({
      task: "Native opt-out",
      transport: "process",
      tools: ["read"],
      extensions: false,
    })) as RaftSurfaceResult;
    expect(native.tools).toEqual(["read"]);
    expect(native.raftExtension).toBeUndefined();
    expect(native.grantedRisks).toEqual([]);
  });

  it("enables loaded extension tools for default Pi children", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      listExtensionTools: () => ["browser"],
    });
    managers.push(manager);
    const result = (await manager.run({
      task: "Default child with extension tools",
      transport: "process",
    })) as RaftSurfaceResult;
    expect(result.tools).toEqual([...DEFAULT_RAFT_CONFIG.agents.defaultTools, "browser"]);
  });

  it("uses native tools for direct children and Raft tools for recursive children", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const direct = (await manager.run({
      task: "Native child of native parent",
      transport: "process",
      tools: ["read"],
    })) as RaftSurfaceResult;
    expect(direct.tools).toEqual(["read"]);
    expect(direct.raftExtension).toBeUndefined();

    // Recursive children keep their recursive surface even from a native parent.
    const recursive = (await manager.run({
      task: "Delegate recursively from a native parent",
      transport: "process",
      tools: ["read"],
      recursive: true,
    })) as RaftSurfaceResult;
    expect(recursive.tools).toEqual(["read", "raft_exec"]);
    expect(recursive.raftExtension).toContain("index");
    expect(recursive.grantedRisks).toEqual(["agent"]);
  });

  it("preserves a custom cwd for a direct agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const leafCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-leaf-cwd-"));
    roots.push(leafCwd);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = (await manager.run({
      task: "Leaf agent with a custom cwd",
      transport: "process",
      tools: ["read"],
      cwd: leafCwd,
    })) as RaftSurfaceResult;
    expect(result.status).toBe("completed");
    expect(result.cwd).toBe(fs.realpathSync(leafCwd));
    expect(result.tools).toEqual(["read"]);
    expect(result.grantedRisks).toEqual([]);
  });

  it.each(['["read","raft_exec"]', "invalid"])(
    "does not widen recursive alternate-cwd authority (%s)",
    async (allowlist) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-recursive-security-"));
      roots.push(root);
      const target = path.join(root, "target");
      fs.mkdirSync(target);
      const saved = process.env.PI_RAFT_TOOL_ALLOWLIST;
      process.env.PI_RAFT_TOOL_ALLOWLIST = allowlist;
      let manager: AgentManager;
      try {
        manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
          workerPath: path.resolve("src/worker.ts"),
          piBinary: path.resolve("tests/fixtures/fake-pi-launch-probe.mjs"),
          runRoot: path.join(root, "runs"),
          projectRoot: process.cwd(),
          kernel: () => "python",
          pythonRuntime: () => "monty",
        });
        managers.push(manager);
      } finally {
        if (saved === undefined) delete process.env.PI_RAFT_TOOL_ALLOWLIST;
        else process.env.PI_RAFT_TOOL_ALLOWLIST = saved;
      }
      const result = await manager.run({
        task: "REPORT_LAUNCH_SURFACE",
        cwd: target,
        recursive: true,
        tools: ["read", "bash", "write"],
        transport: "process",
        capabilityRequirements: ["pi.read"],
      });
      expect(result.status).toBe("completed");
      const tools = allowlist === "invalid" ? ["raft_exec"] : ["read", "raft_exec"];
      expect(JSON.parse(result.text)).toMatchObject({
        cwd: fs.realpathSync(target),
        trustFlags: [],
        tools,
        toolAllowlistEnv: tools,
        grantedRisksEnv: ["agent"],
        extensions: true,
        projectRoot: process.cwd(),
        kernel: "python",
        pythonRuntime: "monty",
        depth: "1",
        capabilityRequirements: ["pi.read"],
      });
    },
  );

  it(
    "launches direct and extension-opt-out children through the real worker",
    { timeout: 15_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
      roots.push(root);
      const fakePi = path.resolve("tests/fixtures/fake-pi-launch-probe.mjs");
      fs.chmodSync(fakePi, 0o755);
      const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePi,
        runRoot: root,
      });
      managers.push(manager);

      const inherited = await manager.run({
        task: "REPORT_LAUNCH_SURFACE",
        transport: "process",
        tools: ["read"],
        timeoutMs: 5_000,
      });
      expect(inherited.status).toBe("completed");
      expect(JSON.parse(inherited.text)).toMatchObject({
        extensions: true,
        tools: ["read"],
        toolAllowlistEnv: ["read"],
        grantedRisksEnv: [],
      });

      const native = await manager.run({
        task: "REPORT_LAUNCH_SURFACE",
        transport: "process",
        tools: ["read"],
        extensions: false,
        timeoutMs: 5_000,
      });
      expect(native.status).toBe("completed");
      expect(JSON.parse(native.text).extensionPath).toBeUndefined();
      expect(JSON.parse(native.text)).toMatchObject({
        extensions: false,
        tools: ["read"],
        toolAllowlistEnv: ["read"],
        grantedRisksEnv: [],
      });
    },
  );

  it("validates structured output through the real Raft worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Return a directive",
      transport: "process",
      systemPrompt: "Return a test directive.",
      schema: {
        type: "object",
        properties: { action: { type: "string", enum: ["message"] }, message: { type: "string" } },
        required: ["action", "message"],
        additionalProperties: false,
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toMatchObject({ action: "message", message: expect.any(String) });
    expect(result.usage).toMatchObject({ input: 3, output: 4 });
  });

  it("keeps the RPC worker alive when Pi announces a retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "RETRY_THEN_SUCCEED",
      transport: "process",
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("retry recovered");
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("preserves provider diagnostics when the final agent attempt fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "FAIL_PROVIDER",
      transport: "process",
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("openai-codex/gpt-test: fetch failed · WebSocket error");
    expect(result.error).not.toContain("exited with code 0");
  });

  it("forwards the configured default model when a call omits one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_RAFT_CONFIG.agents, model: "claude-sonnet-4-5" };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Use the default model", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("claude-sonnet-4-5");
  });

  it("lets a per-call model override the configured default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_RAFT_CONFIG.agents, model: "claude-sonnet-4-5" };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Override the model",
      transport: "process",
      model: "gpt-override",
    });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("gpt-override");
  });

  it("forwards the configured default thinking when a call omits one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_RAFT_CONFIG.agents, thinking: "high" as const };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Use the default thinking", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("high");
  });

  it("lets a per-call thinking override the configured default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_RAFT_CONFIG.agents, thinking: "high" as const };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Override the thinking",
      transport: "process",
      thinking: "max",
    });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("max");
  });

  it("forwards the medium default when neither config nor call set a thinking level", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Default medium thinking", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("medium");
  });

  it("inherits the host model when neither config nor call set one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inherit the host model", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.model).toBeUndefined();
  });

  it("notifies when a detached background agent completes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    let resolveCompletion: ((text: string) => void) | undefined;
    const completion = new Promise<string>((resolve) => {
      resolveCompletion = resolve;
    });
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      onBackgroundComplete: (result) => resolveCompletion?.(result.text),
    });
    managers.push(manager);
    const handle = await manager.spawn({ task: "Background task", transport: "process" });
    manager.detachSignal(handle.id);
    await expect(completion).resolves.toBe("fake worker complete");
  });

  it("surfaces the run-log tail when a worker exits without a terminal result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-crash.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "crash test", transport: "process" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exited without a result");
    expect(result.error).toContain("model rate limit exceeded");
    expect(result.error).toContain("worker_stderr: provider authentication failed retry required");
  }, 30_000);

  it("rejects empty tasks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    await expect(manager.spawn({ task: "" })).rejects.toThrow("must not be empty");
  });

  it("enforces a cross-process cost budget across spawned agents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-budget-"));
    roots.push(root);
    const config = { ...DEFAULT_RAFT_CONFIG.agents, budgetUsd: 0.1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker-budget.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const first = await manager.run({ task: "COST 0.06", transport: "process" });
    expect(first.status).toBe("completed");
    expect(first.usage.cost).toBeCloseTo(0.06);
    expect(first.budget).toBeDefined();
    expect(first.budget?.limit).toBe(0.1);
    expect(first.budget?.spent).toBeCloseTo(0.06);
    expect(first.budget?.remaining).toBeCloseTo(0.04);

    // The check runs before the child lands its cost, so a tree may slightly
    // overshoot (matching ypi's best-effort RLM_BUDGET semantics).
    const second = await manager.run({ task: "COST 0.06", transport: "process" });
    expect(second.status).toBe("completed");
    expect(second.budget?.spent).toBeCloseTo(0.12);
    expect(second.budget?.remaining).toBe(0);

    // A third call is rejected because the accumulated spend now meets the budget.
    await expect(manager.spawn({ task: "COST 0.06", transport: "process" })).rejects.toThrow(
      /budget exceeded/,
    );
  });

  it("inherits a budget ledger from the environment for recursive children", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-budget-"));
    roots.push(root);
    process.env.PI_RAFT_BUDGET = "0.05";
    process.env.PI_RAFT_BUDGET_FILE = path.join(root, "tree-cost.jsonl");
    process.env.PI_RAFT_BUDGET_ID = "inherited-tree";
    fs.writeFileSync(process.env.PI_RAFT_BUDGET_FILE, "", { mode: 0o600 });
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
        workerPath: path.resolve("tests/fixtures/fake-worker-budget.mjs"),
        runRoot: root,
      });
      managers.push(manager);

      const result = await manager.run({ task: "COST 0.02", transport: "process" });
      expect(result.budget?.limit).toBe(0.05);
      expect(result.budget?.spent).toBeCloseTo(0.02);
      expect(result.budget?.remaining).toBeCloseTo(0.03);

      const ledger = fs.readFileSync(process.env.PI_RAFT_BUDGET_FILE, "utf8");
      expect(ledger).toContain('"cost":0.02');
    } finally {
      delete process.env.PI_RAFT_BUDGET;
      delete process.env.PI_RAFT_BUDGET_FILE;
      delete process.env.PI_RAFT_BUDGET_ID;
    }
  });

  it("terminates a child that exceeds the per-child token limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-tokens-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    // The fake pi emits one assistant turn with 7 tokens (input 3 + output 4);
    // a 5-token ceiling trips the guard after the first message_end.
    const config = { ...DEFAULT_RAFT_CONFIG.agents, maxTokensPerChild: 5 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "burn tokens",
      transport: "process",
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("timed_out");
    expect(result.error ?? "").toMatch(/token limit/i);
    expect(result.error ?? "").toMatch(/7 tokens/);
    // The parent model reads this error verbatim: it must name the config key
    // and remedy so the failure is actionable without reading worker.ts.
    expect(result.error ?? "").toContain("agents.maxTokensPerChild");
    expect(result.error ?? "").toContain("/raft settings");
  });
});

describe("AgentManager multimodal prompts", () => {
  it("forwards image blocks to the Pi worker RPC prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-images-"));
    roots.push(root);
    const promptLog = path.join(root, "prompt.json");
    process.env.FAKE_PI_BEHAVIOR = "capture-prompt";
    process.env.FAKE_PI_PROMPT_LOG = promptLog;
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: path.resolve("tests/fixtures/fake-pi.mjs"),
        runRoot: path.join(root, "runs"),
      });
      managers.push(manager);
      const result = await manager.run({
        task: "Inspect the attached image",
        transport: "process",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      });

      expect(result.status).toBe("completed");
      const frame = JSON.parse(fs.readFileSync(promptLog, "utf8")) as Record<string, unknown>;
      expect(frame).toEqual({
        type: "prompt",
        message: "Inspect the attached image",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      });
      expect(fs.existsSync(path.join(manager.runDirectory(result.id)!, "images.json"))).toBe(false);
    } finally {
      delete process.env.FAKE_PI_BEHAVIOR;
      delete process.env.FAKE_PI_PROMPT_LOG;
    }
  });
});

describe("AgentManager Claude runner", () => {
  const fakeClaude = path.resolve("tests/fixtures/fake-claude.mjs");

  it("uses the independent configured Claude runner and model defaults", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-claude-"));
    roots.push(root);
    const config = {
      ...DEFAULT_RAFT_CONFIG.agents,
      runner: "claude" as const,
      model: "openai/pi-only",
      claude: { ...DEFAULT_RAFT_CONFIG.agents.claude, model: "claude/haiku" },
    };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Use Claude defaults", transport: "process" });
    expect(result).toMatchObject({ status: "completed", runner: "claude", model: "claude/haiku" });
  });

  it("runs Claude stream-json with mapped tools, native schema output, and usage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-claude-"));
    roots.push(root);
    const invocationLog = path.join(root, "claude-args.jsonl");
    process.env.FAKE_CLAUDE_LOG = invocationLog;
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        claudeBinary: fakeClaude,
        runRoot: root,
      });
      managers.push(manager);
      const result = await manager.run({
        task: "Return structured output",
        runner: "claude",
        transport: "process",
        model: "claude/haiku",
        thinking: "minimal",
        tools: ["read", "grep", "find", "ls"],
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        runner: "claude",
        model: "claude/haiku",
        thinking: "minimal",
        turns: 2,
        toolCalls: 1,
        value: { ok: true },
        runnerSessionId: "11111111-1111-4111-8111-111111111111",
        usage: { input: 10, output: 7, cacheRead: 2, cacheWrite: 3, cost: 0.001 },
      });
      const invocation = JSON.parse(fs.readFileSync(invocationLog, "utf8").trim()) as {
        argv: string[];
      };
      expect(invocation.argv).toEqual(
        expect.arrayContaining([
          "--model",
          "haiku",
          "--effort",
          "low",
          "--tools",
          "Read,Grep,Glob",
          "--allowedTools",
          "Read,Grep,Glob",
          "--no-session-persistence",
        ]),
      );
      expect(invocation.argv).not.toContain("raft_exec");
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it("preserves Claude result diagnostics on a failed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "CLAUDE_FAIL",
      runner: "claude",
      transport: "process",
      tools: ["read"],
    });
    expect(result).toMatchObject({
      status: "failed",
      runner: "claude",
      error: "fake Claude failure",
      exitCode: 0,
    });
  });

  it("rejects recursive Raft and unsupported tools before launching Claude", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_RAFT_CONFIG.agents, {
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    await expect(
      manager.run({ task: "recurse", runner: "claude", recursive: true }),
    ).rejects.toThrow(/does not support recursive Raft/);
    await expect(
      manager.run({ task: "unknown tool", runner: "claude", tools: ["custom"] }),
    ).rejects.toThrow(/does not support Raft tool/);
    await expect(
      manager.run({ task: "prototype tool", runner: "claude", tools: ["__proto__"] }),
    ).rejects.toThrow(/does not support Raft tool/);
    await expect(
      manager.run({ task: "blank model", runner: "claude", model: "claude/" }),
    ).rejects.toThrow(/must include a runtime model value/);
  });
});
