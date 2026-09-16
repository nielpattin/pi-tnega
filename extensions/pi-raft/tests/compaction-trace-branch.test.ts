import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type {
  ExtensionAPI,
  SessionBeforeTreeEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { compileRaftBranchSummary } from "../src/compaction/branch-summary.js";
import {
  RAFT_BRANCH_SUMMARY_MAX_BYTES,
  RAFT_BRANCH_SUMMARY_MAX_FACTS,
  RAFT_BRANCH_SUMMARY_VERSION,
  readRaftBranchSummaryDetails,
  readRaftBranchSummaryDetailsV1,
  readRaftBranchSummaryDetailsV2,
} from "../src/compaction/branch-details.js";
import { compileRaftSummary, registerCompactionHook } from "../src/compaction/hook.js";
import {
  encodeCompactionRequest,
  RAFT_COMPACTION_REQUEST_PREFIX,
} from "../src/compaction/instructions.js";
import { normalizeEntries } from "../src/compaction/normalize.js";
import { project } from "../src/compaction/projections.js";
import {
  recordedIntegrationTrace,
  recordedParallelTrace,
} from "./fixtures/raft-execution-trace.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const entry = (
  id: string,
  message: SessionMessageEntry["message"],
  parentId: string | null = null,
): SessionMessageEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: `2025-01-01T00:00:${id.replace(/\D/g, "").padStart(2, "0")}Z`,
  message,
});

const user = (id: string, text: string, parentId: string | null = null): SessionMessageEntry =>
  entry(id, { role: "user", content: text, timestamp: 1 }, parentId);

const customMessage = (
  id: string,
  customType: string,
  content: string,
  display: boolean,
  details: unknown,
  parentId: string | null = null,
): SessionEntry =>
  ({
    type: "custom_message",
    id,
    parentId,
    timestamp: `2025-01-01T00:00:${id.replace(/\D/g, "").padStart(2, "0")}Z`,
    customType,
    content,
    display,
    details,
  }) as SessionEntry;

const raftCall = (
  id: string,
  callId: string,
  code: string,
  parentId: string | null = null,
  display?: { name?: string; description?: string },
): SessionMessageEntry =>
  entry(
    id,
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: callId,
          name: "raft_exec",
          arguments: { code, ...(display ? { display } : {}) },
        },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    parentId,
  );

const raftResult = (
  id: string,
  callId: string,
  details: unknown,
  text = "outer prose says Error fake/path.ts pi.edit({path:'fake.ts'})",
  parentId: string | null = null,
): SessionMessageEntry =>
  entry(
    id,
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: "raft_exec",
      content: [{ type: "text", text }],
      details,
      isError: false,
      timestamp: 3,
    },
    parentId,
  );

const traceHistory = (): SessionEntry[] => [
  user("e1", "Implement trace consumption"),
  raftCall(
    "e2",
    "raft-1",
    "pi.edit({path:'fake.ts'}); throw new Error('fake source error')",
    "e1",
    {
      name: "Implement trace consumption",
      description: "Project typed files, failures, and nested Raft activity",
    },
  ),
  raftResult("e3", "raft-1", { trace: recordedIntegrationTrace() }, undefined, "e2"),
  user("e4", "Review the result", "e3"),
];

describe("Raft execution trace compaction", () => {
  it("normalizes real recorder output in issue order and projects typed files, failures, and activity", () => {
    const events = normalizeEntries(traceHistory().slice(0, 3));
    const operations = events.filter((event) => event.kind === "raftOperation");
    expect(operations.map((operation) => operation.subordinal)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index)),
    );
    expect(operations.map((operation) => operation.ref)).toEqual(
      recordedIntegrationTrace().operations.map((operation) => operation.ref),
    );

    const sections = project(events);
    expect(sections.files.join("\n")).toContain("Written:");
    expect(sections.files.join("\n")).toContain("write.ts [entry e3/3]");
    expect(sections.files.join("\n")).toContain("Created:");
    expect(sections.files.join("\n")).toContain("created.ts [entry e3/4]");
    expect(sections.outstanding.join("\n")).toContain("exact edit failure");
    expect(sections.outstanding.join("\n")).toContain("typed test failure");
    expect(
      sections.outstanding.every((line) =>
        line.includes("failure") ? line.includes("[RESOLVED]") : true,
      ),
    ).toBe(true);
    expect(sections.activity.join("\n")).toContain("Implement trace consumption");
    expect(sections.activity.join("\n")).toContain(
      "Project typed files, failures, and nested Raft activity",
    );
    expect(sections.activity.join("\n")).toContain("→ succeeded [entry e2]");
    expect(sections.activity.join("\n")).toContain("Phase: Inspect");
    expect(sections.files.join("\n")).not.toContain("fake.ts");
    expect(sections.outstanding.join("\n")).not.toContain("fake source error");
    expect(sections.activity.join("\n")).not.toContain("fake.ts");
  });

  it("pairs declared intent with aggregate outcome and degrades it by summary tier", () => {
    const events = normalizeEntries(traceHistory());
    const runs = events.filter((event) => event.kind === "raftRun");
    expect(runs).toEqual([
      expect.objectContaining({
        entryId: "e2",
        sourceEntryId: "e3",
        toolCallId: "raft-1",
        address: "e2/call:raft-1",
        name: "Implement trace consumption",
        description: "Project typed files, failures, and nested Raft activity",
        outcome: "succeeded",
        source: "trace",
      }),
    ]);

    const sections = project(events);
    const activity = sections.activity.join("\n");
    const earlier = sections.earlierTurns.join("\n");
    const status = sections.status.join("\n");
    const transcript = sections.transcript.join("\n");
    expect(activity).toContain("Implement trace consumption — Project typed files");
    expect(earlier).toContain('raft:"Implement trace consumption"→succeeded');
    expect(status).toContain("Last execution: Implement trace consumption → succeeded");
    expect(transcript).toContain('raft_exec "Implement trace consumption" → succeeded [entry e2]');
    expect(transcript).not.toContain("Project typed files, failures, and nested Raft activity");
    expect(transcript).not.toContain("raft_exec(structured execution)");
  });

  it("uses a valid trace outcome and requires an exact paired display name", () => {
    const timedOutTrace = recordedParallelTrace();
    timedOutTrace.outcome = "timed_out";
    const paired = normalizeEntries([
      raftCall("o1", "outcome-call", "fake", null, { name: "Probe timeout" }),
      raftResult("o2", "outcome-call", { trace: timedOutTrace }),
    ]).filter((event) => event.kind === "raftRun");
    expect(paired).toMatchObject([{ name: "Probe timeout", outcome: "timed_out" }]);

    const missingName = normalizeEntries([
      raftCall("o3", "description-only", "fake", null, { description: "not enough" }),
      raftResult("o4", "description-only", { trace: recordedParallelTrace() }),
      raftCall("o5", "mismatched", "fake", null, { name: "Must not pair" }),
      raftResult("o6", "different-id", { trace: recordedParallelTrace() }),
    ]).filter((event) => event.kind === "raftRun");
    expect(missingName).toEqual([]);
  });

  it("derives the intent name from the recorded program when no display name is declared", () => {
    const runs = normalizeEntries([
      raftCall("h1", "hint-call", "return await pi.read({ path: 'src/config.ts' });"),
      raftResult("h2", "hint-call", { trace: recordedParallelTrace() }),
    ]).filter((event) => event.kind === "raftRun");
    expect(runs).toMatchObject([{ name: "Read config.ts", outcome: "succeeded" }]);
  });

  it("keeps a declared description when the intent name falls back to the code hint", () => {
    const events = normalizeEntries([
      raftCall("h3", "hint-desc", "return await pi.bash({ cmd: 'pnpm test' });", null, {
        description: "Verify the suite stays green",
      }),
      raftResult("h4", "hint-desc", {}),
    ]);
    const run = events.find((event) => event.kind === "raftRun");
    expect(run).toMatchObject({
      name: "Shell pnpm test",
      description: "Verify the suite stays green",
    });
  });

  it("keeps multibyte intent bounded without clipping outcome or source address", () => {
    const events = normalizeEntries([
      raftCall("mb1", "multibyte", "fake", null, {
        name: "界".repeat(500),
        description: "🚀".repeat(1_000),
      }),
      raftResult("mb2", "multibyte", {}),
    ]);
    const run = events.find((event) => event.kind === "raftRun");
    if (!run || run.kind !== "raftRun") throw new Error("expected run");
    expect(Buffer.byteLength(run.name, "utf8")).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(run.description ?? "", "utf8")).toBeLessThanOrEqual(1024);

    const line = project(events).activity.join("\n");
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(1024);
    expect(line).toContain("→ succeeded [entry mb1]");
  });

  it("preserves parallel issue order independently of completion order", () => {
    const history = [
      user("p1", "parallel"),
      raftCall("p2", "parallel-call", "fake"),
      raftResult("p3", "parallel-call", { trace: recordedParallelTrace() }),
    ];
    const operations = normalizeEntries(history).filter((event) => event.kind === "raftOperation");
    expect(operations.map((operation) => operation.args.path)).toEqual([
      "parallel/first.ts",
      "parallel/second.ts",
    ]);
  });

  it("derives no file or failure facts from prose without a trace, but names the run from code", () => {
    const history = [
      user("f1", "negative"),
      raftCall("f2", "fake-call", "pi.edit({path:'fake-only.ts'}); Error: fake source"),
      raftResult("f3", "fake-call", {}, "pi.bash failed; path fake-output.ts; Error: prose only"),
    ];
    const sections = project(normalizeEntries(history));
    expect(sections.files).toEqual([]);
    expect(sections.outstanding).toEqual([]);
    // The intent label is lexical structure (call root plus arguments), not
    // prose: traceless runs stay visible without reading source or output.
    expect(sections.activity).toContain("- Edit fake-only.ts → succeeded [entry f2]");
  });

  it("uses a strict legacy adapter and never falls back from malformed or unknown traces", () => {
    const legacy = normalizeEntries([
      raftResult("l1", "legacy", {
        audits: [
          {
            ref: "pi.read",
            args: { path: "legacy.ts" },
            success: true,
            error: undefined,
            result: "ignored prose",
          },
        ],
      }),
    ]).filter((event) => event.kind === "raftOperation");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ ref: "pi.read", source: "legacy", outcome: "succeeded" });

    const unknown = normalizeEntries([
      raftResult("u1", "unknown", {
        trace: { ...recordedParallelTrace(), version: 2 },
        audits: [{ ref: "pi.edit", args: { path: "must-ignore.ts" }, success: true }],
      }),
    ]).filter((event) => event.kind === "raftOperation");
    expect(unknown).toEqual([]);

    const malformedLegacy = normalizeEntries([
      raftResult("m1", "malformed", {
        audits: [{ ref: "pi.read", args: { path: "bad.ts" }, success: "yes" }],
      }),
    ]).filter((event) => event.kind === "raftOperation");
    expect(malformedLegacy).toEqual([]);
  });
});

describe("deterministic Raft branch summaries", () => {
  it("compiles and hooks only requested active branch entries while treating instructions as opaque", () => {
    const abandoned = traceHistory().slice(0, 3);
    const first = compileRaftBranchSummary(abandoned, "__pi_vcc__ keep this opaque");
    const second = compileRaftBranchSummary(abandoned, "__pi_vcc__ keep this opaque");
    expect(second).toEqual(first);
    expect(first?.summary).toContain("__pi_vcc__ keep this opaque");
    expect(first?.summary).toContain("[Raft Activity]");
    expect(first?.details.version).toBe(RAFT_BRANCH_SUMMARY_VERSION);
    expect(readRaftBranchSummaryDetailsV2(first?.details)).toEqual(first?.details);
    expect(readRaftBranchSummaryDetails(first?.details)).toEqual(first?.details);
    expect(first?.details.facts).toContainEqual(
      expect.objectContaining({
        kind: "raftRun",
        name: "Implement trace consumption",
        outcome: "succeeded",
      }),
    );

    let handler: ((event: SessionBeforeTreeEvent) => unknown) | undefined;
    const pi = {
      on(name: string, candidate: unknown) {
        if (name === "session_before_tree") handler = candidate as typeof handler;
      },
    } as unknown as ExtensionAPI;
    registerCompactionHook(pi, { getEngine: () => "raft" });
    expect(handler).toBeDefined();
    const preparation = {
      targetId: "target",
      oldLeafId: "e3",
      commonAncestorId: "e1",
      entriesToSummarize: abandoned,
      userWantsSummary: false,
      customInstructions: "ignored because no summary",
    };
    expect(
      handler!({ type: "session_before_tree", preparation, signal: new AbortController().signal }),
    ).toBeUndefined();
    const result = handler!({
      type: "session_before_tree",
      preparation: { ...preparation, userWantsSummary: true },
      signal: new AbortController().signal,
    }) as { summary: { details: unknown } };
    const details = readRaftBranchSummaryDetailsV2(result.summary.details);
    expect(details).toBeDefined();
    expect(details?.source.oldLeafId).toBe("e3");
  });

  it("keeps strict v1 branch envelopes readable without accepting v2 run facts as v1", () => {
    const compiled = compileRaftBranchSummary(traceHistory().slice(0, 3));
    if (!compiled) throw new Error("expected branch summary");
    const legacy = {
      ...structuredClone(compiled.details),
      version: 1,
      facts: compiled.details.facts.filter((fact) => fact.kind !== "raftRun"),
    };
    expect(readRaftBranchSummaryDetailsV1(legacy)).toEqual(legacy);
    expect(readRaftBranchSummaryDetailsV2(legacy)).toBeUndefined();
    expect(readRaftBranchSummaryDetails(legacy)).toEqual(legacy);
    expect(readRaftBranchSummaryDetailsV1(compiled.details)).toBeUndefined();

    const oversized = structuredClone(compiled.details);
    const run = oversized.facts.find((fact) => fact.kind === "raftRun");
    if (!run || run.kind !== "raftRun") throw new Error("expected run fact");
    run.name = "n".repeat(257);
    expect(readRaftBranchSummaryDetailsV2(oversized)).toBeUndefined();
  });

  it("defers replaceInstructions tree navigation to Pi without producing Raft details", () => {
    const abandoned = traceHistory().slice(0, 3);
    let handler: ((event: SessionBeforeTreeEvent) => unknown) | undefined;
    const pi = {
      on(name: string, candidate: unknown) {
        if (name === "session_before_tree") handler = candidate as typeof handler;
      },
    } as unknown as ExtensionAPI;
    registerCompactionHook(pi, { getEngine: () => "raft" });
    const result = handler!({
      type: "session_before_tree",
      preparation: {
        targetId: "target",
        oldLeafId: "e3",
        commonAncestorId: "e1",
        entriesToSummarize: abandoned,
        userWantsSummary: true,
        customInstructions: "Arbitrary replacement summarizer prompt",
        replaceInstructions: true,
      },
      signal: new AbortController().signal,
    });
    expect(result).toBeUndefined();
  });

  it("applies typed instructions fail-closed on the branch path without giving the pi-vcc sentinel tree semantics", () => {
    const abandoned = traceHistory().slice(0, 3);
    const typed = compileRaftBranchSummary(
      abandoned,
      encodeCompactionRequest({
        instructions: "Keep typed branch context",
        preserve: ["EXPLICIT_COMMIT_abc1234", "src/typed.ts"],
      }),
    );
    expect(typed?.summary).toContain("Keep typed branch context");
    expect(typed?.summary).toContain("EXPLICIT_COMMIT_abc1234");
    expect(typed?.summary).toContain("src/typed.ts");

    const exactSentinel = compileRaftBranchSummary(abandoned, "__pi_vcc__");
    expect(exactSentinel?.summary).toContain("__pi_vcc__");

    const malformed = `${RAFT_COMPACTION_REQUEST_PREFIX}${JSON.stringify({
      version: 1,
      goal: "FAKE_BRANCH_GOAL",
      preserve: ["fake/branch.ts"],
    })}`;
    expect(compileRaftBranchSummary(abandoned, malformed)).toBeUndefined();

    let handler: ((event: SessionBeforeTreeEvent, context: unknown) => unknown) | undefined;
    const notifications: string[] = [];
    const pi = {
      on(name: string, candidate: unknown) {
        if (name === "session_before_tree") handler = candidate as typeof handler;
      },
    } as unknown as ExtensionAPI;
    registerCompactionHook(pi, { getEngine: () => "raft" });
    const result = handler!(
      {
        type: "session_before_tree",
        preparation: {
          targetId: "target",
          oldLeafId: "e3",
          commonAncestorId: "e1",
          entriesToSummarize: abandoned,
          userWantsSummary: true,
          customInstructions: malformed,
        },
        signal: new AbortController().signal,
      },
      { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } },
    );
    expect(result).toEqual({ cancel: true });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).not.toContain("FAKE_BRANCH_GOAL");
    expect(notifications[0]).not.toContain("fake/branch.ts");

    const duplicate = `${RAFT_COMPACTION_REQUEST_PREFIX}{"version":1,"ver\\u0073ion":1}`;
    expect(
      handler!(
        {
          type: "session_before_tree",
          preparation: {
            targetId: "target",
            oldLeafId: "e3",
            commonAncestorId: "e1",
            entriesToSummarize: abandoned,
            userWantsSummary: true,
            customInstructions: duplicate,
          },
          signal: new AbortController().signal,
        },
        { hasUI: false },
      ),
    ).toEqual({ cancel: true });
  });

  it("preserves custom-message facts through branch summaries and forks", () => {
    const source = [
      user("c1", "Root task"),
      customMessage(
        "c2",
        "pi-raft-agent-complete",
        "Agent completed CUSTOM_BRANCH_FACT_41",
        false,
        { id: "agent-41", status: "completed" },
        "c1",
      ),
    ];
    const compiled = compileRaftBranchSummary(source, undefined, [], "c2");
    if (!compiled) throw new Error("expected branch summary");
    expect(compiled.details.source.oldLeafId).toBe("c2");
    expect(compiled.details.facts).toContainEqual(
      expect.objectContaining({
        kind: "customMessage",
        customType: "pi-raft-agent-complete",
        text: "Agent completed CUSTOM_BRANCH_FACT_41",
        display: false,
        details: { id: "agent-41", status: "completed" },
      }),
    );
    const summaryEntry = {
      type: "branch_summary",
      id: "c3",
      parentId: "c1",
      timestamp: "2025-01-01T00:00:03Z",
      fromId: "c1",
      summary: "CUSTOM_BRANCH_PROSE_POISON",
      details: compiled.details,
    } as SessionEntry;
    const nested = compileRaftBranchSummary([summaryEntry, user("c4", "Fork continuation", "c3")]);
    expect(nested?.summary).toContain("CUSTOM_BRANCH_FACT_41");
    expect(nested?.summary).not.toContain("CUSTOM_BRANCH_PROSE_POISON");
  });

  it("fails safely on malformed prior custom-message branch facts", () => {
    const compiled = compileRaftBranchSummary([
      customMessage("m1", "safe", "SAFE_PRIOR_CUSTOM", true, { status: "ok" }),
    ]);
    if (!compiled) throw new Error("expected branch summary");
    const malformed = structuredClone(compiled.details) as unknown as {
      facts: Array<{ details?: unknown }>;
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    malformed.facts[0]!.details = cyclic;
    expect(readRaftBranchSummaryDetails(malformed)).toBeUndefined();
    const branchEntry = {
      type: "branch_summary",
      id: "m2",
      parentId: null,
      timestamp: "2025-01-01T00:00:02Z",
      fromId: "wrong-upstream-id",
      summary: "MALFORMED_PRIOR_POISON",
      details: malformed,
    } as SessionEntry;
    const events = normalizeEntries([branchEntry, user("m3", "Safe continuation", "m2")]);
    expect(events).toMatchObject([{ kind: "user", text: "Safe continuation" }]);
    expect(JSON.stringify(events)).not.toContain("MALFORMED_PRIOR_POISON");
  });

  it("reuses active and nested branch facts structurally without sibling contamination, including a forked path", () => {
    const abandoned = traceHistory().slice(0, 3);
    const compiled = compileRaftBranchSummary(abandoned);
    if (!compiled) throw new Error("expected branch summary");
    const root = user("b1", "Active root");
    const branchSummary = {
      type: "branch_summary",
      id: "b2",
      parentId: "b1",
      timestamp: "2025-01-01T00:00:02Z",
      fromId: "e3",
      summary: "SIBLING_PROSE_POISON fake.ts",
      details: compiled.details,
    } as SessionEntry;
    const active = [
      root,
      branchSummary,
      user("b3", "Continue active", "b2"),
      user("b4", "Boundary", "b3"),
    ];
    const result = compileRaftSummary(active, 1_000);
    if (!("compaction" in result)) throw new Error("expected compaction");
    expect(result.compaction.summary).toContain("write.ts");
    expect(result.compaction.summary).toContain("agents.run");
    expect(result.compaction.summary).toContain("Implement trace consumption");
    expect(result.compaction.summary).toContain("[entry e2/call:raft-1]");
    expect(result.compaction.summary).not.toContain("SIBLING_PROSE_POISON");

    const siblingOnly = [
      root,
      user("s2", "Sibling branch poison", "b1"),
      user("s3", "Sibling boundary", "s2"),
    ];
    const siblingResult = compileRaftSummary(siblingOnly, 1_000);
    if (!("compaction" in siblingResult)) throw new Error("expected sibling compaction");
    expect(siblingResult.compaction.summary).not.toContain("write.ts");

    const nested = compileRaftBranchSummary([branchSummary, user("n1", "Nested branch", "b2")]);
    if (!nested) throw new Error("expected nested branch summary");
    const nestedEntry = {
      type: "branch_summary",
      id: "n2",
      parentId: "b1",
      timestamp: "2025-01-01T00:00:04Z",
      fromId: "n1",
      summary: "nested prose ignored",
      details: nested.details,
    } as SessionEntry;
    const forkedPath = [
      root,
      nestedEntry,
      user("f1", "Fork continuation", "n2"),
      user("f2", "Fork boundary", "f1"),
    ];
    const forkResult = compileRaftSummary(forkedPath, 1_000);
    if (!("compaction" in forkResult)) throw new Error("expected fork compaction");
    expect(forkResult.compaction.summary).toContain("created.ts");
    expect(forkResult.compaction.summary).toContain("Implement trace consumption");
  });

  it("bounds facts/details and remains deterministic under large traces", () => {
    const entries: SessionEntry[] = [user("z0", "large branch")];
    for (let index = 0; index < 300; index++) {
      const trace = recordedParallelTrace();
      entries.push(
        raftCall(`z${index * 2 + 1}`, `c${index}`, "fake source", null, {
          name: `Bounded run ${index}`,
          description: "objective ".repeat(200),
        }),
        raftResult(`z${index * 2 + 2}`, `c${index}`, { trace }, "fake output"),
      );
    }
    const first = compileRaftBranchSummary(entries);
    const second = compileRaftBranchSummary(entries);
    expect(second).toEqual(first);
    expect(first!.details.facts.length).toBeLessThanOrEqual(RAFT_BRANCH_SUMMARY_MAX_FACTS);
    expect(first!.details.omittedFacts).toBeGreaterThan(0);
    for (const fact of first!.details.facts) {
      if (fact.kind !== "raftRun" || fact.description === undefined) continue;
      expect(Buffer.byteLength(fact.name, "utf8")).toBeLessThanOrEqual(256);
      expect(Buffer.byteLength(fact.description, "utf8")).toBeLessThanOrEqual(1024);
    }
    expect(Buffer.byteLength(JSON.stringify(first!.details), "utf8")).toBeLessThanOrEqual(
      RAFT_BRANCH_SUMMARY_MAX_BYTES,
    );
  });
});
