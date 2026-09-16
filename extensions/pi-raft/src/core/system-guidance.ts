import type { RaftKernel } from "../runtime/kernel.js";

export const raftExecutionKernelGuidance = (
  kernel: RaftKernel = "typescript",
  pythonRuntime: "cpython" | "monty" = "monty",
): string =>
  [
    kernel === "python"
      ? `Configured raft_exec kernel: Python (${pythonRuntime === "monty" ? "Monty sandboxed subset" : "CPython"}). Write Python only in \`code\`: top-level await/return, dicts, True/False/None, and asyncio.gather. There is no per-call language switch.`
      : "Configured raft_exec kernel: TypeScript. Write TypeScript only in `code`; top-level await and return are supported.",
    "The configured kernel is exclusive for Raft orchestration, including when skills or earlier messages show another language. Do not invoke another interpreter through shell tools or native subprocesses merely to run Raft orchestration in a different language. Project builds, tests, and explicitly requested interpreter work remain legitimate shell commands.",
    "Pi Raft is in orchestration-only mode. Pi core and registered extension tools stay on their native direct execution path; inside raft_exec, `pi.*` and `extensions.*` are unavailable.",
    // Files the model has not opened (images in particular) must be read before
    // use; this line rides the turn-stable kernel guidance so provider prefix
    // caches stay warm.
    "Read every file the user provides (images, screenshots, code, text) with the `read` tool before responding — never assume its contents.",
    "",
  ]
    .filter((section) => section.trim().length > 0)
    .map((section) => section.trim())
    .join(" ");

export const defaultRaftExecutionGuidance = (
  kernel: RaftKernel = "typescript",
  pythonRuntime: "cpython" | "monty" = "monty",
): string =>
  kernel === "python"
    ? (pythonRuntime === "monty"
        ? "Python backend: Monty sandboxed subset, not CPython. Native filesystem/network/environment access and arbitrary imports are unavailable; use host tools for effects. Supply acyclic JSON host arguments; recursive containers are unsupported. Underscore-prefixed direct capability attributes are unavailable: use tools.call with the exact discovered ref instead. π is an attribute object; payloads is a dict, not the same identity. "
        : "Python backend: CPython; native standard-library imports are available. ") +
      'Python raft_exec: write an async function body with `await` and `return`; each invocation starts fresh. Use imports supported by the configured backend, such as `import asyncio`. Host methods accept one dict or keyword arguments: `await tools.call(ref="provider.action", args={"key": "value"})`; read schemas with tools.describe before a computed call. Known actions use mcp.<server>.<tool>, memory.*, or agents.*. Responses are native Python dicts/lists, not attribute objects. Use `asyncio.gather` for independent calls. `π.key` and `payloads["key"]` contain only the exact top-level payload keys. Return JSON-compatible data (convert sets, bytes, paths, and datetimes explicitly); print output is bounded. Provider argument validation and approvals remain host-enforced. Pi core and extensions are unavailable inside raft_exec in orchestration-only mode.'
    : "Call known actions through `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, or `agents.*`; use `tools.search`/`describe` only for dynamic namespaces you cannot name and `tools.call({ref,args})` for computed refs. Other surfaces are opt-in via user-loaded skills.";
