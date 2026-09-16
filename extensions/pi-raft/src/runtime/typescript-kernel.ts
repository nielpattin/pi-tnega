import type { RaftExecutorRuntime } from "../config.js";
import type { RaftGuestTypeSources } from "../protocol.js";
import type { RaftKernelRuntime, RaftHostCall, RaftSandboxOptions } from "./kernel.js";
import { QuickJsRuntime } from "./quickjs-runtime.js";
import { BunProcessRuntime, NodeProcessRuntime } from "./node-process-runtime.js";
import { typeCheckRaftCode } from "./type-checker.js";
import { guestTypeDeclarations } from "./guest-types.js";
import { buildDynamicGuestDeclarations } from "./dynamic-guest-types.js";

// TypeScript is one kernel, with several JavaScript execution engines.
// Keep compiler and guest declaration dependencies behind this lazy boundary.
export class TypeScriptKernelRuntime implements RaftKernelRuntime {
  readonly #runtime: RaftKernelRuntime;

  constructor(runtime: RaftExecutorRuntime) {
    this.#runtime =
      runtime === "node-process"
        ? new NodeProcessRuntime()
        : runtime === "bun-process"
          ? new BunProcessRuntime()
          : new QuickJsRuntime();
  }

  prepare(source: string, unavailable: string[], sources: RaftGuestTypeSources) {
    const checked = typeCheckRaftCode(
      source,
      guestTypeDeclarations({
        excludeGlobals: unavailable,
        dynamic: buildDynamicGuestDeclarations(sources),
      }),
    );
    return { code: source, checked };
  }

  execute(code: string, hostCall: RaftHostCall, options: RaftSandboxOptions) {
    return this.#runtime.execute(code, hostCall, options);
  }
}
