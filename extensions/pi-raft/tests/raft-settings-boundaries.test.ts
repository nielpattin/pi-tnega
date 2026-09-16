import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { openRpcRaftSettings } from "../src/ui/settings-rpc.js";
import { DEFAULT_RAFT_CONFIG } from "../src/config.js";
import { buildExecutorSection } from "../src/ui/settings-sections-execution.js";
import { IntegerInputSubmenu, SectionSubmenu } from "../src/ui/settings-submenus.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

type RpcContext = Parameters<typeof openRpcRaftSettings>[0];

const dialogs = () => ({
  select: vi.fn<RpcContext["ui"]["select"]>(),
  input: vi.fn<RpcContext["ui"]["input"]>(),
  notify: vi.fn<RpcContext["ui"]["notify"]>(),
});

const options = (items: SettingItem[], persist = vi.fn()) => ({
  projectScopeAvailable: false,
  getScope: () => "global" as const,
  setScope: vi.fn(),
  itemsForScope: () => items,
  persist,
});

describe("settings module boundaries", () => {
  it("builds execution settings using only display data and a persistence callback", () => {
    const persist = vi.fn();
    const item = buildExecutorSection({ config: DEFAULT_RAFT_CONFIG, theme, persist });
    const section = item.submenu!(item.currentValue, () => {});
    expect(section).toBeInstanceOf(SectionSubmenu);
    if (!(section instanceof SectionSubmenu)) throw new Error("Expected a section");
    section.applyChange("execution.executor.runtime", "node-process");
    expect(persist).toHaveBeenCalledExactlyOnceWith("execution.executor.runtime", "node-process");
  });

  it("retries invalid RPC integers and commits through the shared submenu", async () => {
    const ui = dialogs();
    const item: SettingItem = {
      id: "agents.maxDepth",
      label: "Depth ›",
      currentValue: "0",
      submenu: (value, done) =>
        new IntegerInputSubmenu(theme, "Depth", "", value, done, () => done()),
    };
    ui.select.mockImplementationOnce(async (_title, rows) => rows[0]);
    ui.select.mockResolvedValueOnce("Done");
    ui.input.mockResolvedValueOnce("-1").mockResolvedValueOnce(" 42 ");
    const config = options([item]);
    await openRpcRaftSettings({ ui }, config);
    expect(ui.notify).toHaveBeenCalledWith("Enter a non-negative safe integer.", "warning");
    expect(config.persist).toHaveBeenCalledExactlyOnceWith("agents.maxDepth", "42");
    expect(item.currentValue).toBe("42");
  });

  it("keeps shared section item references and delegates child changes only once", async () => {
    const ui = dialogs();
    const child: SettingItem = {
      id: "tools.mcp.enabled",
      label: "Enabled",
      currentValue: "true",
      values: ["true", "false"],
    };
    const apply = vi.fn();
    const root: SettingItem = {
      id: "tools.mcp",
      label: "MCP ›",
      currentValue: "enabled",
      submenu: (_value, done) =>
        new SectionSubmenu(theme, "MCP", undefined, [child], apply, () => done()),
    };
    ui.select
      .mockImplementationOnce(async (_title, rows) => rows[0])
      .mockImplementationOnce(async (_title, rows) => rows[0])
      .mockResolvedValueOnce("false")
      .mockResolvedValueOnce("← Back")
      .mockResolvedValueOnce("Done");
    const config = options([root]);
    await openRpcRaftSettings({ ui }, config);
    expect(child.currentValue).toBe("false");
    expect(apply).toHaveBeenCalledExactlyOnceWith("tools.mcp.enabled", "false");
    expect(config.persist).not.toHaveBeenCalled();
  });

  it("does not persist cancelled submenu input or offer untrusted scope switching", async () => {
    const ui = dialogs();
    const item: SettingItem = {
      id: "agents.maxDepth",
      label: "Depth",
      currentValue: "0",
      submenu: (value, done) =>
        new IntegerInputSubmenu(theme, "Depth", "", value, done, () => done()),
    };
    ui.select
      .mockImplementationOnce(async (_title, rows) => {
        expect(rows.some((row) => row.startsWith("Switch save scope"))).toBe(false);
        return rows[0];
      })
      .mockResolvedValueOnce("Done");
    ui.input.mockResolvedValueOnce(undefined);
    const config = options([item]);
    await openRpcRaftSettings({ ui }, config);
    expect(config.persist).not.toHaveBeenCalled();
    expect(config.setScope).not.toHaveBeenCalled();
    expect(item.currentValue).toBe("0");
  });
});
