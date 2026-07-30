/**
 * Unit tests for the agy harness: arg building, effort mapping, and a
 * controllable mock process lifecycle.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Effect, Exit, Scope, Stream } from "effect";
import {
  DEFAULT_AGY_MODEL,
  buildAgyArgs,
  buildTaskkillArgs,
  createAgyBackend,
  extractAgyConversationId,
  mapReasoningEffort,
  pathExistsExecutable,
  resetAgyBinaryCache,
  resolveAgyBinary,
  resolveAgyCliModel,
  type AgySpawnFn,
} from "./src/backends/agy.ts";
import type { ParentContext, SpawnTask, TaskEvent } from "./src/domain.ts";
import type { TaskSession } from "./src/backend.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string, overrides: Partial<SpawnTask> = {}): SpawnTask {
  return {
    prompt,
    title: "test",
    cwd: process.cwd(),
    parent,
    ...overrides,
  };
}

interface MockChild extends EventEmitter {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => boolean;
}

interface ControllableSpawn {
  readonly spawn: AgySpawnFn;
  readonly child: MockChild;
  pushStdout(chunk: string): void;
  pushStderr(chunk: string): void;
  close(code?: number | null, signal?: NodeJS.Signals | null): void;
}

function makeControllableSpawn(options: { pid?: number } = {}): ControllableSpawn {
  const child = new EventEmitter() as MockChild;
  child.pid = options.pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal?: NodeJS.Signals) => {
    // Mimic process death after kill for interrupt tests.
    queueMicrotask(() => {
      child.emit("close", signal ? 1 : 0, signal ?? null);
      child.emit("exit", signal ? 1 : 0, signal ?? null);
    });
    return true;
  };

  const spawnImpl: AgySpawnFn = () => child as any;

  return {
    spawn: spawnImpl,
    child,
    pushStdout(chunk) {
      child.stdout.emit("data", chunk);
    },
    pushStderr(chunk) {
      child.stderr.emit("data", chunk);
    },
    close(code = 0, signal = null) {
      child.emit("close", code, signal);
      child.emit("exit", code, signal);
    },
  };
}

async function withSession(
  backend: ReturnType<typeof createAgyBackend>,
  spawnTask: SpawnTask,
  run: (session: TaskSession) => Promise<void>,
) {
  const scope = Effect.runSync(Scope.make());
  try {
    const session = await Effect.runPromise(
      Scope.provide(backend.spawn(spawnTask), scope),
    );
    await run(session);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

async function takeEvents(
  events: Stream.Stream<TaskEvent>,
  count: number,
  timeoutMs = 1_000,
): Promise<TaskEvent[]> {
  const collected: TaskEvent[] = [];
  await Effect.runPromise(
    Stream.take(events, count).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          collected.push(event);
        }),
      ),
      Effect.timeout(timeoutMs),
    ),
  );
  return collected;
}

test("mapReasoningEffort maps shared scale onto agy low/medium/high", () => {
  assert.equal(mapReasoningEffort(undefined), "low");
  assert.equal(mapReasoningEffort("off"), "low");
  assert.equal(mapReasoningEffort("minimal"), "low");
  assert.equal(mapReasoningEffort("low"), "low");
  assert.equal(mapReasoningEffort("medium"), "medium");
  assert.equal(mapReasoningEffort("high"), "high");
  assert.equal(mapReasoningEffort("xhigh"), "high");
  assert.equal(mapReasoningEffort("max"), "high");
});

test("resolveAgyCliModel defaults to gemini-3.6-flash-low", () => {
  assert.equal(resolveAgyCliModel(undefined, undefined), "gemini-3.6-flash-low");
  assert.equal(resolveAgyCliModel("gemini-3.6-flash", "medium"), "gemini-3.6-flash-medium");
  assert.equal(resolveAgyCliModel("gemini-3.6-flash", "high"), "gemini-3.6-flash-high");
  assert.equal(resolveAgyCliModel("gemini-3.6-flash", "xhigh"), "gemini-3.6-flash-high");
});

test("resolveAgyCliModel rewrites effort suffix when present", () => {
  assert.equal(
    resolveAgyCliModel("gemini-3.6-flash-high", "medium"),
    "gemini-3.6-flash-medium",
  );
  assert.equal(
    resolveAgyCliModel("gemini-3.5-flash-low", "high"),
    "gemini-3.5-flash-high",
  );
});

test("resolveAgyCliModel leaves non-effort-encoded models alone", () => {
  assert.equal(resolveAgyCliModel("claude-sonnet-4-6", "high"), "claude-sonnet-4-6");
  assert.equal(
    resolveAgyCliModel("claude-opus-4-6-thinking", "medium"),
    "claude-opus-4-6-thinking",
  );
});

test("buildAgyArgs defaults model/effort and always uses print mode", () => {
  const args = buildAgyArgs({
    prompt: "do the thing",
    cwd: "C:\\work\\project",
  });
  assert.deepEqual(args, [
    "--model",
    "gemini-3.6-flash-low",
    "--effort",
    "low",
    "--mode",
    "accept-edits",
    "--dangerously-skip-permissions",
    "--add-dir",
    "C:\\work\\project",
    "--print-timeout",
    "15m",
    "--print",
    "do the thing",
  ]);
});

test("buildAgyArgs includes log-file and conversation resume flags", () => {
  const args = buildAgyArgs({
    prompt: "resume me",
    cwd: "/tmp/x",
    conversationId: "12b548a6-f808-42cf-aded-25720a796f16",
    logFile: "C:\\temp\\agy.log",
  });
  assert.equal(args[0], "--conversation");
  assert.equal(args[1], "12b548a6-f808-42cf-aded-25720a796f16");
  assert.equal(args[2], "--log-file");
  assert.equal(args[3], "C:\\temp\\agy.log");
  assert.equal(args.at(-1), "resume me");
});

test("buildAgyArgs composes gemini-3.6-flash + medium effort", () => {
  const args = buildAgyArgs({
    prompt: "audit this",
    cwd: "/tmp/x",
    model: "gemini-3.6-flash",
    reasoningEffort: "medium",
  });
  assert.equal(args[1], "gemini-3.6-flash-medium");
  assert.equal(args[3], "medium");
  assert.equal(args.at(-1), "audit this");
});

test("buildTaskkillArgs force-kills the process tree", () => {
  assert.deepEqual(buildTaskkillArgs(1234), ["/pid", "1234", "/T", "/F"]);
});

test("pathExistsExecutable accepts existing files without X_OK on Windows", () => {
  const file = path.join(
    os.tmpdir(),
    `agy-path-test-${process.pid}-${Date.now()}.txt`,
  );
  fs.writeFileSync(file, "ok");
  try {
    assert.equal(pathExistsExecutable(file), true);
  } finally {
    fs.unlinkSync(file);
  }
});

test("resolveAgyBinary finds agy on PATH when present", () => {
  resetAgyBinaryCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
  const binary = path.join(
    dir,
    process.platform === "win32" ? "agy.exe" : "agy",
  );
  fs.writeFileSync(binary, "");
  try {
    const found = resolveAgyBinary({ PATH: dir });
    assert.equal(found, binary);
  } finally {
    resetAgyBinaryCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agy backend streams stdout and settles as completed", async () => {
  const mock = makeControllableSpawn();
  const backend = createAgyBackend({
    resolveBinary: () => "/fake/agy",
    spawn: mock.spawn,
  });

  await withSession(backend, task("Say hello"), async (session) => {
    // RunStarted + MetaChanged + UserMessage + 2 deltas + AssistantMessage + RunSettled
    const collector = takeEvents(session.events, 7);
    await Promise.resolve();
    mock.pushStdout("hel");
    mock.pushStdout("lo world");
    mock.close(0);

    const events = await collector;
    const tags = events.map((e) => e._tag);
    assert.ok(tags.includes("RunStarted"));
    assert.ok(tags.includes("AssistantDelta"));
    assert.ok(tags.includes("AssistantMessage"));
    assert.ok(tags.includes("RunSettled"));

    const settled = events.find((e) => e._tag === "RunSettled");
    assert.ok(settled && settled._tag === "RunSettled");
    assert.equal(settled.outcome._tag, "Completed");
    if (settled.outcome._tag === "Completed") {
      assert.equal(settled.outcome.finalText, "hello world");
    }

    const meta = await Effect.runPromise(session.meta);
    assert.equal(meta.backend, "agy");
    assert.equal(meta.modelLabel, "gemini-3.6-flash-low");
  });
});

test("agy meta.modelLabel reflects composed effort model", async () => {
  const mock = makeControllableSpawn();
  const backend = createAgyBackend({
    resolveBinary: () => "/fake/agy",
    spawn: mock.spawn,
  });

  await withSession(
    backend,
    task("Say hello", {
      model: "gemini-3.6-flash",
      reasoningEffort: "medium",
    }),
    async (session) => {
      const meta = await Effect.runPromise(session.meta);
      assert.equal(meta.modelLabel, "gemini-3.6-flash-medium");
      mock.close(0);
    },
  );
});

test("agy backend fails with stderr when process exits non-zero", async () => {
  const mock = makeControllableSpawn();
  const backend = createAgyBackend({
    resolveBinary: () => "/fake/agy",
    spawn: mock.spawn,
  });

  await withSession(backend, task("FAIL please"), async (session) => {
    const collector = takeEvents(session.events, 4);
    await Promise.resolve();
    mock.pushStderr("model blew up");
    mock.close(2);

    const events = await collector;
    const settled = events.find((e) => e._tag === "RunSettled");
    assert.ok(settled && settled._tag === "RunSettled");
    assert.equal(settled.outcome._tag, "Failed");
    if (settled.outcome._tag === "Failed") {
      assert.match(settled.outcome.errorText, /model blew up/);
    }
  });
});

test("extractAgyConversationId prefers printmode log lines", () => {
  assert.equal(
    extractAgyConversationId(
      'I0723 printmode.go:216] Print mode: conversation=12b548a6-f808-42cf-aded-25720a796f16, sending message',
    ),
    "12b548a6-f808-42cf-aded-25720a796f16",
  );
  assert.equal(
    extractAgyConversationId(
      "Created conversation 9d19dea3-37c6-4c84-8d4d-50825235e712",
    ),
    "9d19dea3-37c6-4c84-8d4d-50825235e712",
  );
  assert.equal(
    extractAgyConversationId(
      "Conversation ID: **`12b548a6-f808-42cf-aded-25720a796f16`**",
    ),
    "12b548a6-f808-42cf-aded-25720a796f16",
  );
});

test("agy send is rejected when conversation ID is missing", async () => {
  const mock = makeControllableSpawn();
  const backend = createAgyBackend({
    resolveBinary: () => "/fake/agy",
    spawn: mock.spawn,
  });

  await withSession(backend, task("one shot"), async (session) => {
    mock.close(0);
    const exit = await Effect.runPromiseExit(session.send("more please"));
    assert.equal(Exit.isFailure(exit), true);
  });
});

test("agy send succeeds when conversation ID is captured from private log", async () => {
  const logFile = path.join(
    os.tmpdir(),
    `agy-test-log-${process.pid}-${Date.now()}.log`,
  );
  const mock = makeControllableSpawn();
  const backend = createAgyBackend({
    resolveBinary: () => "/fake/agy",
    spawn: (command, args, options) => {
      // Write a realistic private log as agy would when --log-file is set.
      const logIdx = args.indexOf("--log-file");
      if (logIdx >= 0) {
        const target = String(args[logIdx + 1]);
        fs.writeFileSync(
          target,
          `Print mode: conversation=12b548a6-f808-42cf-aded-25720a796f16, sending message\n`,
        );
      } else {
        fs.writeFileSync(
          logFile,
          `Print mode: conversation=12b548a6-f808-42cf-aded-25720a796f16, sending message\n`,
        );
      }
      return mock.spawn(command, args, options);
    },
  });

  await withSession(backend, task("first turn"), async (session) => {
    await Promise.resolve();
    mock.pushStdout("Done without id in stdout.");
    mock.close(0);
    // allow close handler to read log + capture id
    await new Promise((r) => setTimeout(r, 20));

    const meta = await Effect.runPromise(session.meta);
    assert.equal(meta.nativeSessionId, "12b548a6-f808-42cf-aded-25720a796f16");

    const exit = await Effect.runPromiseExit(session.send("second turn"));
    assert.equal(Exit.isSuccess(exit), true);
    mock.close(0);
  });
});

test("agy interrupt settles as Interrupted", async () => {
  const mock = makeControllableSpawn();
  const backend = createAgyBackend({
    resolveBinary: () => "/fake/agy",
    spawn: mock.spawn,
  });

  await withSession(backend, task("long task"), async (session) => {
    // RunStarted + MetaChanged + UserMessage + AssistantDelta + RunSettled
    const collector = takeEvents(session.events, 5);
    await Promise.resolve();
    mock.pushStdout("partial");
    await Effect.runPromise(session.interrupt);

    const events = await collector;
    const settled = events.find((e) => e._tag === "RunSettled");
    assert.ok(settled && settled._tag === "RunSettled");
    assert.equal(settled.outcome._tag, "Interrupted");
  });
});

test("agy spawn fails when binary is missing", async () => {
  const backend = createAgyBackend({
    resolveBinary: () => undefined,
  });
  const exit = await Effect.runPromiseExit(
    Effect.scoped(backend.spawn(task("no binary"))),
  );
  assert.equal(Exit.isFailure(exit), true);
});

test("default agyBackend export is wired", async () => {
  const { agyBackend } = await import("./src/backends/agy.ts");
  assert.equal(agyBackend.name, "agy");
  assert.equal(agyBackend.capabilities.steering, true);
  assert.equal(agyBackend.capabilities.modelSelection, true);
});
