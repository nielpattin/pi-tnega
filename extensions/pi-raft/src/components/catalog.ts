import type { RaftComponentDefinition, RaftComponentDiscovery } from "./types.js";

export interface RaftComponentCatalogEntry {
  definition: RaftComponentDefinition;
  revision: number;
}

export interface RaftComponentCatalogEvent {
  name: string;
  current?: RaftComponentCatalogEntry;
  previous?: RaftComponentCatalogEntry;
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class RaftComponentCatalog {
  readonly #definitions = new Map<string, RaftComponentCatalogEntry>();
  readonly #listeners = new Set<(event: RaftComponentCatalogEvent) => void>();

  readonly discovery: RaftComponentDiscovery = {
    version: 1,
    register: (component, options) => this.register(component, options),
  };

  register(definition: RaftComponentDefinition, options: { overwrite?: boolean } = {}): void {
    if (!NAME_PATTERN.test(definition.name)) {
      throw new Error(`Invalid Raft component name: ${definition.name}`);
    }
    if (typeof definition.activate !== "function") {
      throw new Error(`Raft component ${definition.name} must define activate()`);
    }
    const previous = this.#definitions.get(definition.name);
    if (previous && !options.overwrite) {
      throw new Error(`Raft component already registered: ${definition.name}`);
    }
    const current = { definition, revision: (previous?.revision ?? 0) + 1 };
    this.#definitions.set(definition.name, current);
    this.#emit({ name: definition.name, current, ...(previous ? { previous } : {}) });
  }

  unregister(name: string): RaftComponentDefinition | undefined {
    const previous = this.#definitions.get(name);
    if (!previous) return undefined;
    this.#definitions.delete(name);
    this.#emit({ name, previous });
    return previous.definition;
  }

  get(name: string): RaftComponentCatalogEntry | undefined {
    return this.#definitions.get(name);
  }

  list(): Array<RaftComponentCatalogEntry & { name: string }> {
    return [...this.#definitions.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  clear(): void {
    for (const name of Array.from(this.#definitions.keys())) this.unregister(name);
  }

  subscribe(listener: (event: RaftComponentCatalogEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: RaftComponentCatalogEvent): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(event);
      } catch {
        // Registration observers do not own the catalog mutation.
      }
    }
  }
}
