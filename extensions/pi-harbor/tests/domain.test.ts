import { describe, it, expect } from "vitest";
import {
  CapacityError,
  ConcurrencyLimitError,
  SchemaConversionError,
  SchemaValidationError,
  ControlError,
  CancelError,
  formatJobId,
  formatProcessId,
  normalizeTaskSpecs,
  prependContext,
  mapThinkingLevel,
  mapAgyEffort
} from "../src/domain.js";

describe("Domain & Pure Helpers", () => {
  it("instantiates TaggedErrorClass errors properly", () => {
    const capErr = new CapacityError({ message: "Job registry full", limit: 64 });
    expect(capErr._tag).toBe("CapacityError");
    expect(capErr.message).toBe("Job registry full");
    expect(capErr.limit).toBe(64);

    const concErr = new ConcurrencyLimitError({ message: "Max running subagents exceeded", limit: 4 });
    expect(concErr._tag).toBe("ConcurrencyLimitError");
    expect(concErr.limit).toBe(4);

    const convErr = new SchemaConversionError({ message: "Invalid schema document" });
    expect(convErr._tag).toBe("SchemaConversionError");

    const valErr = new SchemaValidationError({ message: "Output schema validation failed" });
    expect(valErr._tag).toBe("SchemaValidationError");

    const ctrlErr = new ControlError({ message: "Control unsupported" });
    expect(ctrlErr._tag).toBe("ControlError");

    const cancelErr = new CancelError({ message: "Operation cancelled" });
    expect(cancelErr._tag).toBe("CancelError");
  });

  it("formats job and process IDs correctly", () => {
    expect(formatJobId(1)).toBe("task-1");
    expect(formatJobId(42)).toBe("task-42");
    expect(formatProcessId(1)).toBe("bash-1");
    expect(formatProcessId(5)).toBe("bash-5");
  });

  it("normalizes batch vs flat task payloads", () => {
    const flat = normalizeTaskSpecs({ task: "do something", name: "test-job" });
    expect(flat).toHaveLength(1);
    expect(flat[0].task).toBe("do something");
    expect(flat[0].name).toBe("test-job");

    const batch = normalizeTaskSpecs({
      context: "Background info",
      tasks: [
        { task: "subtask 1" },
        { task: "subtask 2" }
      ]
    });
    expect(batch).toHaveLength(2);
    expect(batch[0].task).toBe("subtask 1");
    expect(batch[1].task).toBe("subtask 2");
  });

  it("prepends shared context to task prompts", () => {
    const tasks = [
      { task: "do feature A" },
      { task: "do feature B" }
    ];
    const prepended = prependContext(tasks, "Project context: build target ESM");
    expect(prepended[0].task).toBe("Project context: build target ESM\n\ndo feature A");
    expect(prepended[1].task).toBe("Project context: build target ESM\n\ndo feature B");
  });

  it("maps reasoning_effort to Pi thinkingLevel correctly", () => {
    expect(mapThinkingLevel("off")).toBe("off");
    expect(mapThinkingLevel("minimal")).toBe("minimal");
    expect(mapThinkingLevel("low")).toBe("low");
    expect(mapThinkingLevel("medium")).toBe("medium");
    expect(mapThinkingLevel("high")).toBe("high");
    expect(mapThinkingLevel("xhigh")).toBe("xhigh");
    expect(mapThinkingLevel("max")).toBe("max");
    expect(mapThinkingLevel(undefined)).toBe("medium");
  });

  it("maps reasoning_effort to agy --effort correctly", () => {
    expect(mapAgyEffort("off")).toBe("low");
    expect(mapAgyEffort("minimal")).toBe("low");
    expect(mapAgyEffort("low")).toBe("low");
    expect(mapAgyEffort("medium")).toBe("medium");
    expect(mapAgyEffort("high")).toBe("high");
    expect(mapAgyEffort("xhigh")).toBe("high");
    expect(mapAgyEffort("max")).toBe("high");
    expect(mapAgyEffort(undefined)).toBe("medium");
  });
});
