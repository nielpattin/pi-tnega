import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import {
  createProviderComponent,
  type RaftProviderComponent,
  type RaftProviderComponentManifest,
} from "./components/provider-component.js";
import type { RaftConfig } from "./config.js";
import type { ActionRegistry } from "./core/action-registry.js";
import { resolveAgentDir } from "./core/agent-dir.js";
import { McpDescriptorCacheStore } from "./providers/mcp-descriptor-cache.js";
import { McpProvider } from "./providers/mcp-provider.js";
import { MemoryProvider, type MemoryProviderContext } from "./providers/memory-provider.js";

/** Built-in provider recipes and policy; the runtime chooses installation order. */
export class RuntimeStateBuiltins {
  constructor(
    private readonly manifest: RaftProviderComponentManifest,
    private readonly registry: ActionRegistry,
    private readonly onInstalled: (name: string) => void,
  ) {}

  async install(component: RaftProviderComponent): Promise<void> {
    await this.manifest.install(component);
    this.onInstalled(component.definition.name);
  }

  async tools(cwd: string, config: RaftConfig): Promise<void> {
    let mcpProvider: McpProvider | undefined;
    await this.install(
      createProviderComponent({
        provider: "mcp",
        description: "MCP runtime and descriptor cache",
        create: () =>
          new McpProvider(cwd, config.tools.mcp, {
            ...(config.tools.mcp.cache.enabled
              ? {
                  cache: new McpDescriptorCacheStore(
                    path.join(
                      process.env.PI_RAFT_PROJECT_ROOT ?? cwd,
                      ".pi",
                      "raft",
                      "mcp-cache.json",
                    ),
                  ),
                }
              : {}),
            hooks: {
              onSliceChanged: () => {
                this.registry.notifyCatalogChanged("mcp");
              },
            },
          }),
        mounted: (provider) => {
          mcpProvider = provider;
        },
        unmounted: (provider) => {
          if (mcpProvider === provider) mcpProvider = undefined;
        },
        start: (provider) => {
          provider.warmup();
        },
      }),
    );
  }

  async memory(context: ExtensionContext, config: RaftConfig, sessionId: string): Promise<void> {
    if (config.memory.enabled) {
      const sessionFile = context.sessionManager.getSessionFile();
      const memoryContext: MemoryProviderContext = {
        agentDir: resolveAgentDir(),
        cwd: context.cwd,
        config: config.memory,
        sessionId,
        ...(sessionFile ? { sessionFile } : {}),
        getLiveBranch: () => ({
          entries: context.sessionManager.getBranch(),
          leafId: context.sessionManager.getLeafId(),
        }),
      };
      await this.install(
        createProviderComponent({
          provider: "memory",
          description: "Session memory index and source hydration",
          create: () => new MemoryProvider(memoryContext),
        }),
      );
    }
  }

  assertActive(config: RaftConfig): void {
    const expectedBuiltinProviders = new Set<string>([
      "mcp",
      "agents",
      ...(config.memory.enabled ? ["memory"] : []),
    ]);
    this.manifest.assertActive(expectedBuiltinProviders, this.registry);
  }
}
