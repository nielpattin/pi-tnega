import type { ActionRegistry } from "../core/action-registry.js";
import type { RaftProvider } from "../protocol.js";
import type { RaftComponentCatalog } from "./catalog.js";
import type { RaftComponentLoader } from "./loader.js";
import type { RaftComponentContext, RaftComponentDefinition, RaftComponentEntry } from "./types.js";

export const RAFT_PROVIDER_COMPONENT_PREFIX = "raft.provider.";

export const RAFT_COMPONENT_PROVIDER_NAMES = [
  "pi",
  "extensions",
  "mcp",
  "compact",
  "agents",
  "memory",
] as const;

export interface RaftProviderComponentSpec<TProvider extends RaftProvider> {
  provider: string;
  description: string;
  requires?: RaftComponentDefinition["requires"];
  create(context: RaftComponentContext): TProvider | Promise<TProvider>;
  mounted?(provider: TProvider): void;
  unmounted?(provider: TProvider): void;
  start?(provider: TProvider): void | Promise<void>;
}

export interface RaftProviderComponent {
  entry: RaftComponentEntry;
  definition: RaftComponentDefinition;
}

export class RaftProviderComponentManifest {
  readonly #entries: RaftComponentEntry[] = [];

  constructor(
    readonly catalog: RaftComponentCatalog,
    readonly loader: RaftComponentLoader,
  ) {}

  entries(): RaftComponentEntry[] {
    return this.#entries.map((entry) => structuredClone(entry));
  }

  async install(component: RaftProviderComponent): Promise<void> {
    const definitionName = component.definition.name;
    const provider = definitionName.startsWith(RAFT_PROVIDER_COMPONENT_PREFIX)
      ? definitionName.slice(RAFT_PROVIDER_COMPONENT_PREFIX.length)
      : undefined;
    if (
      !provider ||
      component.entry.id !== definitionName ||
      component.entry.component !== definitionName ||
      component.definition.provides?.length !== 1 ||
      component.definition.provides[0] !== provider
    ) {
      throw new Error(`Invalid Raft provider component manifest entry: ${definitionName}`);
    }
    if (this.#entries.some((entry) => entry.id === component.entry.id)) {
      throw new Error(`Duplicate Raft provider component: ${component.entry.id}`);
    }
    const previousDefinition = this.catalog.get(component.definition.name)?.definition;
    this.catalog.register(component.definition, { overwrite: previousDefinition !== undefined });
    this.#entries.push(structuredClone(component.entry));
    try {
      await this.loader.installPinned(this.#entries);
    } catch (error) {
      this.#entries.pop();
      if (previousDefinition) {
        this.catalog.register(previousDefinition, { overwrite: true });
      } else {
        this.catalog.unregister(component.definition.name);
      }
      throw error;
    }
  }

  async uninstall(provider: string): Promise<void> {
    const componentName = `${RAFT_PROVIDER_COMPONENT_PREFIX}${provider}`;
    const index = this.#entries.findIndex((entry) => entry.component === componentName);
    if (index < 0) return;
    const previous = this.#entries.slice();
    this.#entries.splice(index, 1);
    try {
      await this.loader.installPinned(this.#entries);
    } catch (error) {
      this.#entries.splice(0, this.#entries.length, ...previous);
      throw error;
    }
  }

  assertActive(expectedProviders: Iterable<string>, registry: ActionRegistry): void {
    const expected = new Set(expectedProviders);
    const installed = new Set(
      this.#entries.map((entry) => entry.component.slice(RAFT_PROVIDER_COMPONENT_PREFIX.length)),
    );
    const missing = [...expected].filter((name) => !installed.has(name) || !registry.has(name));
    const unexpected = [...installed].filter((name) => !expected.has(name));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Raft provider component manifest mismatch. Missing: ${missing.join(",") || "none"}. Unexpected: ${unexpected.join(",") || "none"}.`,
      );
    }
  }
}

const providerComponentName = (provider: string): string =>
  `${RAFT_PROVIDER_COMPONENT_PREFIX}${provider}`;

export const createProviderComponent = <TProvider extends RaftProvider>(
  spec: RaftProviderComponentSpec<TProvider>,
): RaftProviderComponent => {
  const name = providerComponentName(spec.provider);
  const definition: RaftComponentDefinition = {
    name,
    description: spec.description,
    ...(spec.requires ? { requires: spec.requires } : {}),
    provides: [spec.provider],
    guarantee: "managed",
    async activate(context) {
      const provider = await spec.create(context);
      if (provider.name !== spec.provider) {
        await provider.close?.();
        throw new Error(
          `Raft provider component ${name} created ${provider.name}, expected ${spec.provider}`,
        );
      }
      try {
        context.provide(provider);
      } catch (error) {
        await provider.close?.();
        throw error;
      }
      if (spec.mounted) {
        try {
          spec.mounted(provider);
        } catch (error) {
          spec.unmounted?.(provider);
          throw error;
        }
        context.defer(() => spec.unmounted?.(provider), {
          label: `provider-component:${spec.provider}:holder`,
          kind: "transactional",
          resources: [`raft:provider:${spec.provider}:holder`],
          ordering: "ordered",
        });
      }
      await spec.start?.(provider);
    },
  };
  return { entry: { id: name, component: name }, definition };
};
