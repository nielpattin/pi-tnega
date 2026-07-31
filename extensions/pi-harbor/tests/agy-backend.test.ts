import { describe, it, expect } from "vitest";
import { buildAgyArgv, AgyBackend } from "../src/backends/agy.js";
import { ShellExecutor } from "../src/services/ShellExecutor.js";
import { ManagedRuntime, Layer } from "effect";

describe("Agy Backend Phase 1a One-Shot Execution", () => {
  const LiveLayer = AgyBackend.layer.pipe(
    Layer.provide(ShellExecutor.layer)
  );
  const runtime = ManagedRuntime.make(LiveLayer);

  it("builds correct agy print argv structure", () => {
    const argv = buildAgyArgv({
      model: "gemini-3.6-flash-medium",
      effort: "medium",
      cwd: "/workspace",
      prompt: "Fix bug in index.ts"
    });

    expect(argv).toEqual([
      "--model", "gemini-3.6-flash-medium",
      "--mode", "accept-edits",
      "--dangerously-skip-permissions",
      "--add-dir", "/workspace",
      "--print-timeout", "15m",
      "--print", "Fix bug in index.ts"
    ]);

    // Ensure --print is the last argument
    expect(argv[argv.length - 2]).toBe("--print");
    expect(argv[argv.length - 1]).toBe("Fix bug in index.ts");
  });

  it.each([
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gemini-3.6-flash-low",
    "gpt-oss-120b-medium"
  ])("never combines explicit Agy model %s with --effort", (model) => {
    const argv = buildAgyArgv({ model, effort: "medium", prompt: "Test" });

    expect(argv).toContain("--model");
    expect(argv).toContain(model);
    expect(argv).not.toContain("--effort");
  });

  it("uses --effort when no explicit Agy model is selected", () => {
    const argv = buildAgyArgv({ effort: "high", prompt: "Test" });

    expect(argv).not.toContain("--model");
    expect(argv).toContain("--effort");
    expect(argv).toContain("high");
  });

  it("executes one-shot print command and returns completed state on exit 0", async () => {
    const result = await runtime.runPromise(
      AgyBackend.use((backend) =>
        backend.runOneShot({
          model: "gemini-3.6-flash-medium",
          effort: "low",
          cwd: process.cwd(),
          prompt: "Echo test",
          overrideCommand: "node -e process.stdout.write(Buffer.from([84,97,115,107,32,102,105,110,105,115,104,101,100,32,115,117,99,99,101,115,115,102,117,108,108,121]))"
        })
      )
    );

    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("Task finished successfully");
  });

  it("returns failed state on non-zero exit code", async () => {
    const result = await runtime.runPromise(
      AgyBackend.use((backend) =>
        backend.runOneShot({
          model: "gemini-3.6-flash-medium",
          effort: "low",
          cwd: process.cwd(),
          prompt: "Error test",
          overrideCommand: "node -e process.stderr.write(Buffer.from([69,114,114,111,114,32,111,99,99,117,114,114,101,100]));process.exit(1)"
        })
      )
    );

    expect(result.status).toBe("failed");
    expect(result.errorText).toContain("Error occurred");
  });
});
