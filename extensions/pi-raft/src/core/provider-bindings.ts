import { randomUUID } from "node:crypto";
import type { RaftComponentProviderLease } from "../components/types.js";
import type { RaftProvider } from "../protocol.js";

type RaftProviderBindingState = "staged" | "active" | "retiring" | "closed";

export interface RaftProviderBinding {
  id: string;
  name: string;
  generation: number;
  provider: RaftProvider;
  state: RaftProviderBindingState;
  ownerRetained: boolean;
  allowReplace: boolean;
  retainers: number;
  inFlight: number;
  closeTask?: Promise<void>;
  closeError?: string;
  unsubscribeCatalog?: () => void;
}

export type RaftProviderBindingEvent =
  | { type: "staged" | "activated" | "retiring" | "closed"; binding: RaftProviderBinding }
  | { type: "catalog"; provider: string };

const snapshot = (binding: RaftProviderBinding): RaftProviderBinding => ({
  ...binding,
  ...(binding.closeTask ? { closeTask: binding.closeTask } : {}),
});

export class RaftProviderBindings {
  readonly #current = new Map<string, RaftProviderBinding>();
  readonly #staged = new Map<string, RaftProviderBinding>();
  readonly #all = new Map<string, RaftProviderBinding>();
  readonly #generations = new Map<string, number>();
  readonly #listeners = new Set<(event: RaftProviderBindingEvent) => void>();

  subscribe(listener: (event: RaftProviderBindingEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  current(name: string): RaftProviderBinding | undefined {
    return this.#current.get(name);
  }

  binding(id: string): RaftProviderBinding | undefined {
    const binding = this.#all.get(id);
    return binding?.state === "closed" ? undefined : binding;
  }

  has(name: string): boolean {
    return this.#current.has(name);
  }

  providers(): RaftProvider[] {
    return [...this.#current.values()].map((binding) => binding.provider);
  }

  entries(): RaftProviderBinding[] {
    return [...this.#all.values()].filter((binding) => binding.state !== "closed");
  }

  mount(
    provider: RaftProvider,
    options: { overwrite?: boolean; staged?: boolean } = {},
  ): RaftComponentProviderLease {
    const current = this.#current.get(provider.name);
    const staged = this.#staged.get(provider.name);
    if ((current || staged) && !options.overwrite) {
      throw new Error(`Raft provider already registered: ${provider.name}`);
    }
    if (staged && options.overwrite) this.retire(staged.id);
    const generation = (this.#generations.get(provider.name) ?? 0) + 1;
    this.#generations.set(provider.name, generation);
    const binding: RaftProviderBinding = {
      id: randomUUID(),
      name: provider.name,
      generation,
      provider,
      state: options.staged ? "staged" : "active",
      ownerRetained: true,
      allowReplace: options.overwrite === true,
      retainers: 0,
      inFlight: 0,
    };
    if (provider.subscribeCatalog) {
      binding.unsubscribeCatalog = provider.subscribeCatalog(() =>
        this.notifyCatalogChanged(provider.name),
      );
    }
    this.#all.set(binding.id, binding);
    if (options.staged) {
      this.#staged.set(binding.name, binding);
      this.#emit({ type: "staged", binding: snapshot(binding) });
    } else {
      const replaced = this.#activateOne(binding);
      if (replaced && options.overwrite) void this.releaseOwner(replaced.id).catch(() => undefined);
    }

    let released = false;
    return {
      bindingId: binding.id,
      name: binding.name,
      generation: binding.generation,
      get active() {
        return binding.state === "active";
      },
      retire: () => this.retire(binding.id),
      release: async () => {
        if (released) return binding.closeTask;
        released = true;
        return this.releaseOwner(binding.id);
      },
    };
  }

  activate(bindingIds: readonly string[]): string[] {
    const bindings = bindingIds.map((id) => {
      const binding = this.#all.get(id);
      if (!binding || binding.state === "closed") {
        throw new Error(`Unknown Raft provider binding: ${id}`);
      }
      if (binding.state !== "staged" && binding.state !== "active") {
        throw new Error(`Raft provider binding is ${binding.state}: ${binding.name}`);
      }
      return binding;
    });
    const names = new Set<string>();
    for (const binding of bindings) {
      if (names.has(binding.name)) {
        throw new Error(`Cannot activate multiple Raft bindings for provider ${binding.name}`);
      }
      names.add(binding.name);
      const current = this.#current.get(binding.name);
      if (current && current.id !== binding.id && !binding.allowReplace) {
        throw new Error(`Raft provider already registered: ${binding.name}`);
      }
    }
    const replaced: string[] = [];
    for (const binding of bindings) {
      const previous = this.#activateOne(binding);
      if (previous && previous.id !== binding.id) {
        replaced.push(previous.id);
        if (binding.allowReplace) void this.releaseOwner(previous.id).catch(() => undefined);
      }
    }
    return replaced;
  }

  unregister(name: string): RaftProvider | undefined {
    const binding = this.#current.get(name);
    if (!binding) return undefined;
    this.retire(binding.id);
    void this.releaseOwner(binding.id).catch(() => undefined);
    return binding.provider;
  }

  retire(id: string): void {
    const binding = this.#all.get(id);
    if (!binding || binding.state === "retiring" || binding.state === "closed") return;
    if (this.#current.get(binding.name)?.id === id) this.#current.delete(binding.name);
    if (this.#staged.get(binding.name)?.id === id) this.#staged.delete(binding.name);
    binding.state = "retiring";
    this.#emit({ type: "retiring", binding: snapshot(binding) });
    void this.#maybeClose(binding).catch(() => undefined);
  }

  retain(ids: Iterable<string>): () => Promise<void> {
    const retained: RaftProviderBinding[] = [];
    try {
      for (const id of new Set(ids)) {
        const binding = this.#all.get(id);
        if (!binding || binding.state === "closed") {
          throw new Error(`Unknown Raft provider binding: ${id}`);
        }
        binding.retainers++;
        retained.push(binding);
      }
    } catch (error) {
      for (const binding of retained) binding.retainers--;
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await Promise.all(
        retained.map(async (binding) => {
          binding.retainers = Math.max(0, binding.retainers - 1);
          await this.#maybeClose(binding);
        }),
      );
    };
  }

  beginInvocation(id: string): () => Promise<void> {
    const binding = this.#all.get(id);
    if (!binding || binding.state === "closed") {
      throw new Error(`Unknown Raft provider binding: ${id}`);
    }
    binding.inFlight++;
    let ended = false;
    return async () => {
      if (ended) return;
      ended = true;
      binding.inFlight = Math.max(0, binding.inFlight - 1);
      await this.#maybeClose(binding);
    };
  }

  notifyCatalogChanged(provider: string): void {
    if (this.#current.has(provider)) this.#emit({ type: "catalog", provider });
  }

  async close(excludedProviderNames: Set<string> = new Set()): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const binding of this.#all.values()) {
      if (binding.state === "closed") continue;
      if (excludedProviderNames.has(binding.name)) {
        if (this.#current.get(binding.name)?.id === binding.id) this.#current.delete(binding.name);
        binding.unsubscribeCatalog?.();
        delete binding.unsubscribeCatalog;
        binding.state = "closed";
        this.#all.delete(binding.id);
        continue;
      }
      this.retire(binding.id);
      binding.ownerRetained = false;
      binding.retainers = 0;
      tasks.push(this.#maybeClose(binding));
    }
    await Promise.allSettled(tasks);
    this.#current.clear();
    this.#staged.clear();
  }

  #activateOne(binding: RaftProviderBinding): RaftProviderBinding | undefined {
    const current = this.#current.get(binding.name);
    if (current?.id === binding.id && binding.state === "active") return current;
    if (current && current.id !== binding.id) this.retire(current.id);
    if (this.#staged.get(binding.name)?.id === binding.id) this.#staged.delete(binding.name);
    binding.state = "active";
    this.#current.set(binding.name, binding);
    this.#emit({ type: "activated", binding: snapshot(binding) });
    return current;
  }

  private async releaseOwner(id: string): Promise<void> {
    const binding = this.#all.get(id);
    if (!binding) return;
    this.retire(id);
    binding.ownerRetained = false;
    await this.#maybeClose(binding);
  }

  async #maybeClose(binding: RaftProviderBinding): Promise<void> {
    if (
      binding.state !== "retiring" ||
      binding.ownerRetained ||
      binding.retainers > 0 ||
      binding.inFlight > 0
    ) {
      return;
    }
    if (binding.closeTask) return binding.closeTask;
    binding.closeTask = (async () => {
      binding.unsubscribeCatalog?.();
      delete binding.unsubscribeCatalog;
      try {
        await binding.provider.close?.();
      } catch (error) {
        binding.closeError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        binding.state = "closed";
        this.#all.delete(binding.id);
        this.#emit({ type: "closed", binding: snapshot(binding) });
      }
    })();
    return binding.closeTask;
  }

  #emit(event: RaftProviderBindingEvent): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(event);
      } catch {
        // Registry listeners are observations; one listener cannot break provider ownership.
      }
    }
  }
}
