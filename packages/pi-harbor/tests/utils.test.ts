import { describe, it, expect, vi } from "vitest";
import { buildChildEnv } from "../src/utils/shell-env.js";
import { OutputBuffer } from "../src/utils/output-buffer.js";
import { killTree } from "../src/utils/kill-tree.js";
import { checkLogReady, checkPortReady } from "../src/utils/ready-poller.js";
import { awaitStreamClose } from "../src/utils/stream-close.js";
import { EventEmitter } from "node:events";

describe("Harbor Utility Modules", () => {
  describe("shell-env", () => {
    it("prepends Git Bash PATH when shell is sh.exe or bash.exe", () => {
      const parentEnv = { PATH: "C:\\Windows\\System32;C:\\Cmd" };
      const shellPath = "C:\\Program Files\\Git\\bin\\sh.exe";
      const env = buildChildEnv(parentEnv, shellPath);
      expect(env.PATH).toContain("Git");
      expect(env.PATH).toContain("C:\\Windows\\System32");
    });

    it("returns shallow copy of parentEnv when shell is not Git Bash", () => {
      const parentEnv = { PATH: "C:\\Windows\\System32" };
      const shellPath = "C:\\Windows\\System32\\cmd.exe";
      const env = buildChildEnv(parentEnv, shellPath);
      expect(env.PATH).toBe("C:\\Windows\\System32");
    });
  });

  describe("output-buffer", () => {
    it("accumulates text and view snapshot correctly", () => {
      const buf = new OutputBuffer(1024);
      buf.push("hello ");
      buf.push("world");
      const v = buf.view();
      expect(v.text).toBe("hello world");
      expect(v.totalBytes).toBe(11);
      expect(v.truncatedBytes).toBe(0);
    });

    it("evicts oldest chunks when maxRetainedBytes is exceeded", () => {
      const buf = new OutputBuffer(10);
      buf.push("123456");
      buf.push("789012");
      const v = buf.view();
      expect(v.text).toBe("789012");
      expect(v.totalBytes).toBe(12);
      expect(v.truncatedBytes).toBe(6);
    });
  });

  describe("kill-tree", () => {
    it("calls process kill on child process without pid", () => {
      const fakeChild = {
        kill: vi.fn()
      } as any;
      killTree(fakeChild, "SIGTERM");
      expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  describe("ready-poller", () => {
    it("matches log output regex pattern", () => {
      expect(checkLogReady("Server running on port 8080", "running on port \\d+")).toBe(true);
      expect(checkLogReady("Server starting", "running")).toBe(false);
    });
  });

  describe("stream-close", () => {
    it("resolves when stream emits close event", async () => {
      const emitter = new EventEmitter();
      const promise = awaitStreamClose(emitter, 1000);
      emitter.emit("close");
      const closed = await promise;
      expect(closed).toBe(true);
    });
  });
});
