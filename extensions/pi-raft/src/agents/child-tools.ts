/** Pi core tools that can be granted to a spawned child. */
export const CHILD_CORE_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

const RAFT_EXEC_TOOL = "raft_exec";

const CORE_TOOL_SET: ReadonlySet<string> = new Set(CHILD_CORE_TOOLS);

const unique = (names: readonly string[]): string[] => [...new Set(names.filter(Boolean))];

/** Extension-registered tool names, excluding Pi core tools and raft_exec. */
export const extensionToolCandidates = (registered: readonly string[]): string[] =>
  unique(registered.filter((name) => name !== RAFT_EXEC_TOOL && !CORE_TOOL_SET.has(name))).sort();

/**
 * Extension-registered names that shadow a Pi core tool: the extension
 * implementation runs instead of the builtin under the same name.
 */
export const shadowedCoreTools = (registered: readonly string[]): string[] =>
  unique(registered.filter((name) => CORE_TOOL_SET.has(name))).sort();
/** Picker entries: core tools plus loaded extension tools plus currently enabled extras. */
export const childToolPickerCandidates = (
  registered: readonly string[] = [],
  extra: readonly string[] = [],
): string[] => unique([...CHILD_CORE_TOOLS, ...extensionToolCandidates(registered), ...extra]);

export interface ChildToolSelection {
  /** Positive allowlist: core tools plus extension tools enabled explicitly. */
  defaultTools: readonly string[];
  /** Names turned off in the picker. Wins over the positive allowlist. */
  excludeTools: readonly string[];
}

/**
 * Whether a candidate is checked in Enable Tools.
 * Core tools default to the positive allowlist; extension tools default to on,
 * so only an explicit exclude turns one off.
 */
export const isChildToolEnabled = (
  name: string,
  registered: readonly string[] = [],
  selection: ChildToolSelection,
): boolean => {
  if (selection.excludeTools.includes(name)) return false;
  if (CORE_TOOL_SET.has(name)) return selection.defaultTools.includes(name);
  if (extensionToolCandidates(registered).includes(name)) return true;
  return selection.defaultTools.includes(name);
};

/** Split a checked set back into the persisted positive list and exclude list. */
export const selectionFromChecked = (
  checked: readonly string[],
  registered: readonly string[] = [],
  previous: ChildToolSelection,
): ChildToolSelection => {
  const candidates = childToolPickerCandidates(registered, [
    ...previous.defaultTools,
    ...previous.excludeTools,
  ]);
  const checkedSet = new Set(checked);
  return {
    // Extras outside the visible candidate set are preserved, not silently dropped.
    defaultTools: unique([...candidates, ...previous.defaultTools]).filter((name) =>
      checkedSet.has(name),
    ),
    excludeTools: candidates.filter((name) => !checkedSet.has(name)),
  };
};

export interface ResolveChildToolsInput {
  defaultTools: readonly string[];
  excludeTools?: readonly string[];
  /** Live extension tool names; granted on top of the allowlist when extensions run. */
  extensionTools?: readonly string[];
  includeRaftExec?: boolean;
  inheritedAllowlist?: ReadonlySet<string>;
}

/**
 * Tools the child process should receive. Extension tools are on by default:
 * the allowlist is unioned with live extension names and then reduced by the
 * exclude list. raft_exec is never taken from the user list.
 */
export const resolveChildTools = (input: ResolveChildToolsInput): string[] => {
  const inherited = input.inheritedAllowlist;
  const excluded = new Set(input.excludeTools ?? []);
  const granted = unique([...input.defaultTools, ...(input.extensionTools ?? [])]);
  const tools = granted.filter((tool) => {
    if (tool === RAFT_EXEC_TOOL) return false;
    if (excluded.has(tool)) return false;
    if (inherited !== undefined && !inherited.has(tool)) return false;
    return true;
  });
  if (input.includeRaftExec) tools.push(RAFT_EXEC_TOOL);
  return tools;
};
