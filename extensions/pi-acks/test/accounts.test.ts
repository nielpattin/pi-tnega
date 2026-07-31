// Cohesion justification: this account-manager integration matrix shares credential/provider
// fixtures and cross-covers menus, OAuth, replacement, switching, persistence, and lifecycle safety.
import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "./support.js";
import accountsExtension, {
	ACCOUNTS_STATUS_KEY,
	AccountStore,
	FAIL_CLOSED_API_KEY,
	parseAccountName,
	type StoredOAuthCredential,
} from "../src/accounts.js";
import {
	type AccountProviderAdapter,
	createBuiltinProviderAdapters,
	createOAuthInteraction,
} from "../src/oauth.js";
import { RuntimeAuthCoordinator, type RuntimeAccountStore } from "../src/runtime-auth.js";
import { InMemoryAccountStorageBackend } from "../src/storage.js";

const credential = (
	suffix: string,
	extra: Record<string, unknown> = {},
): StoredOAuthCredential => ({
	type: "oauth",
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: Date.now() + 60 * 60 * 1000,
	accountId: `acct-${suffix}`,
	...extra,
});

function fakeProvider(
	id: AccountProviderAdapter["id"],
	options: {
		baseUrl?: string;
		headers?: Record<string, string>;
		requiresApiKeyBridge?: boolean;
	} = {},
): AccountProviderAdapter {
	return {
		id,
		displayName: "OpenAI Codex",
		requiresApiKeyBridge: options.requiresApiKeyBridge ?? true,
		oauth: {
			async login() {
				return credential(`login-${id}`);
			},
			async refresh(current) {
				return { ...current, access: `${current.access}-refreshed`, expires: Date.now() + 60_000 };
			},
			async toAuth(current) {
				return { apiKey: current.access, baseUrl: options.baseUrl, headers: options.headers };
			},
		},
	};
}

function runtimeHarness(mock: ReturnType<typeof createMockPi>) {
	const keys = new Map<string, string>();
	const persistent = new Map<string, unknown>();
	const models = [
		{ provider: "openai-codex", id: "codex", baseUrl: "https://codex.example" },
		{ provider: "openai-codex", id: "allowed", baseUrl: "https://codex.example" },
		{ provider: "openai-codex", id: "blocked", baseUrl: "https://codex.example" },
	];
	const runtime = {
		async setRuntimeApiKey(provider: string, key: string) {
			keys.set(provider, key);
		},
		async removeRuntimeApiKey(provider: string) {
			keys.delete(provider);
		},
		async modify(provider: string, fn: (current: unknown) => unknown) {
			const current = persistent.get(provider);
			const next = await fn(current);
			if (next === undefined) persistent.delete(provider);
			else persistent.set(provider, next);
			return next;
		},
		async delete(provider: string) {
			persistent.delete(provider);
		},
		async read(provider: string) {
			return persistent.get(provider);
		},
	};
	const registry = {
		runtime,
		getRegisteredProviderConfig: (provider: string) => mock.providers.get(provider),
		getApiKeyForProvider: async (provider: string) => keys.get(provider),
		getAll: () =>
			models.map((model) => ({
				...model,
				name: model.id,
				api: "openai-responses",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			})),
		find(provider: string, id: string) {
			const model = models.find((item) => item.provider === provider && item.id === id);
			if (!model) return undefined;
			const config = mock.providers.get(provider) as
				| { baseUrl?: string; models?: Array<{ id: string }> }
				| undefined;
			if (config?.models && !config.models.some((item) => item.id === id)) return undefined;
			return { ...model, baseUrl: config?.baseUrl ?? model.baseUrl };
		},
		async getApiKeyAndHeaders(model: { provider: string }) {
			const config = mock.providers.get(model.provider) as
				| { headers?: Record<string, string> }
				| undefined;
			return { ok: true as const, apiKey: keys.get(model.provider), headers: config?.headers };
		},
	};
	return { keys, persistent, registry, runtime };
}

function createInteractiveAccountContext(
	overrides: Record<string, unknown> = {},
	options: {
		selections?: string[];
		inputs?: Array<string | undefined>;
		confirms?: boolean[];
	} = {},
) {
	const selections = [...(options.selections ?? [])];
	const inputs = [...(options.inputs ?? [])];
	const confirms = [...(options.confirms ?? [])];
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const inputCalls: Array<{ title: string; placeholder?: string }> = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const context = createMockContext({
		hasUI: true,
		...overrides,
		select: async (title: string, values: string[]) => {
			selectCalls.push({ title, options: values });
			const selected = selections.shift();
			if (selected !== undefined)
				assert.ok(values.includes(selected), `Missing option: ${selected}`);
			return selected;
		},
		input: async (title: string, placeholder?: string) => {
			inputCalls.push({ title, placeholder });
			return inputs.shift();
		},
		confirm: async (title: string, message: string) => {
			confirmCalls.push({ title, message });
			return confirms.shift() ?? true;
		},
	});
	return { ...context, selectCalls, inputCalls, confirmCalls };
}

test("built-in provider adapters preserve the complete OAuth auth shape", async () => {
	const adapters = createBuiltinProviderAdapters();
	const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));

	const base = credential("contract");

	assert.equal(typeof byId.get("openai-codex")?.invalidateConnections, "function");
	assert.deepEqual(await byId.get("openai-codex")?.oauth.toAuth(base), {
		apiKey: "access-contract",
	});
});

test("OAuth interaction preserves provider prompts, cancellation, and notifications", async () => {
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		input: async () => undefined,
		select: async () => "Device login",
	});
	const interaction = createOAuthInteraction(ctx, "Example");
	assert.equal(
		await interaction.prompt({
			type: "select",
			message: "Method",
			options: [
				{ id: "browser", label: "Browser" },
				{ id: "device", label: "Device login" },
			],
		}),
		"device",
	);
	await assert.rejects(
		interaction.prompt({ type: "manual_code", message: "Code" }),
		/Login cancelled/,
	);
	interaction.notify({
		type: "device_code",
		userCode: "ABCD",
		verificationUri: "https://example.test/device",
	});
	assert.match(notifications.at(-1)?.message ?? "", /ABCD/);
});

test("accounts registers only the interactive /accounts command and lifecycle hooks", () => {
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store: new AccountStore(new InMemoryAccountStorageBackend()),
		providers: [fakeProvider("openai-codex")],
	});

	assert.deepEqual([...mock.commands.keys()].toSorted(), ["accounts"]);
	assert.deepEqual([...mock.events.keys()].toSorted(), [
		"before_agent_start",
		"model_select",
		"session_shutdown",
		"session_start",
		"turn_start",
	]);
});

test("account names reserve default for Pi login", () => {
	assert.equal(parseAccountName(" work-1 ").ok, true);
	assert.equal(parseAccountName("../secret").ok, false);
	assert.equal(parseAccountName("default").ok, true);
});

test("accounts command ignores arguments but requires interactive UI", async () => {
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store: new AccountStore(new InMemoryAccountStorageBackend()),
		providers: [fakeProvider("openai-codex")],
	});
	const { ctx, notifications } = createMockContext({ hasUI: false });

	await mock.commands.get("accounts")?.handler("switch anthropic work", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /requires interactive UI/);
	assert.equal(notifications.at(-1)?.level, "error");
});

test("accounts empty state offers only login and ignores command arguments", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx, selectCalls } = createInteractiveAccountContext(
		{ model: { provider: "openai-codex", id: "codex" }, modelRegistry: registry },
		{ selections: [] },
	);

	await mock.commands.get("accounts")?.handler("anything ignored", ctx);

	assert.match(selectCalls[0]?.title ?? "", /No saved accounts yet/);
	assert.deepEqual(selectCalls[0]?.options, ["Login new account"]);
});

test("accounts menu summarizes the supported provider and prioritizes the current account", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "work",
				accounts: { personal: credential("personal"), work: credential("work") },
			},
		},
	});
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx, selectCalls } = createInteractiveAccountContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	await mock.commands.get("accounts")?.handler("ignored", ctx);

	assert.match(selectCalls[0]?.title ?? "", /Current model:\nOpenAI Codex \/ codex/);
	assert.match(selectCalls[0]?.title ?? "", /OpenAI Codex: work/);
	assert.deepEqual(selectCalls[0]?.options, [
		"Switch OpenAI Codex account",
		"Login new account",
		"Remove account",
	]);
});

test("accounts menu uses generic provider switch for unsupported current models", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { accounts: { work: credential("work") } },
		},
	});
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx, selectCalls } = createInteractiveAccountContext({
		model: { provider: "google", id: "gemini" },
		modelRegistry: registry,
	});

	await mock.commands.get("accounts")?.handler("ignored", ctx);

	assert.deepEqual(selectCalls[0]?.options, [
		"Login new account",
		"Switch provider account",
		"Remove account",
	]);
});

test("accounts menu switch-current activates the selected account", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				accounts: { work: credential("codex") },
			},
		},
	});
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx, selectCalls } = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Switch OpenAI Codex account", "work"] },
	);

	await mock.commands.get("accounts")?.handler("ignored", ctx);

	assert.equal((await store.readProviderAsync("openai-codex")).active, "work");
	assert.equal(keys.get("openai-codex"), "access-codex");
	assert.deepEqual(selectCalls[1]?.options, ["✓ default", "work"]);
});

test("provider account activates independently and default clears only it", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "personal", accounts: { personal: credential("codex") } },
		},
	});
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx, notifications } = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Switch OpenAI Codex account", "default"] },
	);

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.equal(keys.get("openai-codex"), "access-codex");

	await mock.commands.get("accounts")?.handler("ignored", ctx);
	const data = await store.readAsync();
	assert.equal(data.providers["openai-codex"]?.active, undefined);
	assert.equal(keys.has("openai-codex"), false);
	assert.match(notifications.at(-1)?.message ?? "", /default Pi OpenAI Codex login/);
});

test("active account mirrors into Pi's credential store and default removes it", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("work") } },
		},
	});
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry, persistent } = runtimeHarness(mock);
	const { ctx } = createInteractiveAccountContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	const mirrored = persistent.get("openai-codex") as
		| { access?: string; accountId?: string }
		| undefined;
	assert.equal(mirrored?.access, "access-work");
	assert.equal(mirrored?.accountId, "acct-work");

	const switchContext = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Switch OpenAI Codex account", "default"] },
	).ctx;
	await mock.commands.get("accounts")?.handler("ignored", switchContext);
	assert.equal(persistent.has("openai-codex"), false);
});

test("default clears only the mirror that matches the last activated account", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("work") } },
		},
	});
	const mock = createMockPi();
	const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("openai-codex"));
	const { registry, persistent, runtime } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	await coordinator.ensureActive(ctx, store);
	assert.equal(
		(persistent.get("openai-codex") as { accountId?: string } | undefined)?.accountId,
		"acct-work",
	);

	// Pi's own login takes over the stored entry with a different account.
	await runtime.modify("openai-codex", () => credential("foreign", { accountId: "acct-foreign" }));
	const empty: RuntimeAccountStore = {
		readProviderAsync: async () => ({ active: undefined, accounts: {} }),
		updateProviderAsync: async (_providerId, fn) => fn({ active: undefined, accounts: {} }),
	};
	await coordinator.ensureActive(ctx, empty);
	assert.equal(
		(persistent.get("openai-codex") as { accountId?: string } | undefined)?.accountId,
		"acct-foreign",
	);
});

test("an older credential mirror cannot clobber a newer activation", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "alpha",
				accounts: { alpha: credential("alpha"), beta: credential("beta") },
			},
		},
	});
	let releaseAlpha: (() => void) | undefined;
	const alphaBlocked = new Promise<void>((resolve) => {
		releaseAlpha = resolve;
	});
	let signalAlpha: (() => void) | undefined;
	const alphaStarted = new Promise<void>((resolve) => {
		signalAlpha = resolve;
	});
	const codex = fakeProvider("openai-codex");
	codex.oauth.toAuth = async (current) => {
		if (current.access === "access-alpha") {
			signalAlpha?.();
			await alphaBlocked;
		}
		return { apiKey: current.access };
	};
	const mock = createMockPi();
	const coordinator = new RuntimeAuthCoordinator(mock.pi, codex);
	const { registry, persistent } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	const older = coordinator.ensureActive(ctx, store);
	await alphaStarted;
	await store.updateProvider("openai-codex", (state) => ({ ...state, active: "beta" }));
	await coordinator.ensureActive(ctx, store);
	releaseAlpha?.();
	await older;

	assert.equal(
		(persistent.get("openai-codex") as { access?: string } | undefined)?.access,
		"access-beta",
	);
});

test("default Codex auth does not invalidate connections on first observation", async () => {
	const invalidations: Array<string | undefined> = [];
	const codex = fakeProvider("openai-codex");
	codex.invalidateConnections = (sessionId) => {
		invalidations.push(sessionId);
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store: new AccountStore(new InMemoryAccountStorageBackend()),
		providers: [codex],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.deepEqual(invalidations, []);
});

test("Codex connections invalidate only when the applied account identity changes", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("codex") } },
		},
	});
	const invalidations: Array<string | undefined> = [];
	const codex = fakeProvider("openai-codex");
	codex.invalidateConnections = (sessionId) => {
		invalidations.push(sessionId);
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
	assert.deepEqual(invalidations, ["test-session"]);
	const switchContext = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Switch OpenAI Codex account", "default"] },
	).ctx;
	await mock.commands.get("accounts")?.handler("ignored", switchContext);
	assert.deepEqual(invalidations, ["test-session", "test-session"]);
});

test("an older overlapping provider sync cannot publish stale inactive state", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("codex") } },
		},
	});
	let releaseFirst: (() => void) | undefined;
	const firstBlocked = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let signalFirst: (() => void) | undefined;
	const firstStarted = new Promise<void>((resolve) => {
		signalFirst = resolve;
	});
	let conversions = 0;
	const invalidations: Array<string | undefined> = [];
	const codex = fakeProvider("openai-codex");
	codex.oauth.toAuth = async (current) => {
		conversions += 1;
		if (conversions === 1) {
			signalFirst?.();
			await firstBlocked;
			throw new Error("obsolete conversion failed");
		}
		return { apiKey: current.access };
	};
	codex.invalidateConnections = (sessionId) => {
		invalidations.push(sessionId);
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx, statuses } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	const older = mock.events.get("session_start")?.[0]?.({}, ctx);
	await firstStarted;
	await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
	releaseFirst?.();
	await older;

	assert.equal(keys.get("openai-codex"), "access-codex");
	assert.equal(statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
	assert.deepEqual(invalidations, ["test-session"]);
});

test("an obsolete invalidation failure cannot fail closed a newer successful sync", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("codex") } },
		},
	});
	const originalRead = store.readProviderAsync.bind(store);
	let reads = 0;
	let releaseObsoleteRead: (() => void) | undefined;
	const obsoleteReadBlocked = new Promise<void>((resolve) => {
		releaseObsoleteRead = resolve;
	});
	let signalObsoleteRead: (() => void) | undefined;
	const obsoleteReadStarted = new Promise<void>((resolve) => {
		signalObsoleteRead = resolve;
	});
	store.readProviderAsync = async (providerId) => {
		reads += 1;
		if (reads === 4) {
			signalObsoleteRead?.();
			await obsoleteReadBlocked;
		}
		return originalRead(providerId);
	};
	let invalidations = 0;
	const codex = fakeProvider("openai-codex");
	codex.invalidateConnections = () => {
		invalidations += 1;
		if (invalidations === 1) throw new Error("obsolete cleanup failed");
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx, statuses } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	const older = mock.events.get("session_start")?.[0]?.({}, ctx);
	await obsoleteReadStarted;
	await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
	releaseObsoleteRead?.();
	await older;

	assert.equal(keys.get("openai-codex"), "access-codex");
	assert.equal(statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
});

test("connection invalidation failure replaces active Codex auth with fail-closed state", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("codex") } },
		},
	});
	const codex = fakeProvider("openai-codex");
	codex.invalidateConnections = () => {
		throw new Error("socket cleanup failed");
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx, statuses } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
	assert.match(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/);
});

test("generic login stores the full provider-owned credential and activates it", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Login new account", "OpenAI Codex"], inputs: ["personal"] },
	);

	await mock.commands.get("accounts")?.handler("ignored", ctx);
	const stored = (await store.readAsync()).providers["openai-codex"];
	assert.equal(stored?.active, "personal");
	assert.equal(stored?.accounts.personal?.accountId, "acct-login-openai-codex");
	assert.equal(keys.get("openai-codex"), "access-login-openai-codex");
});

test("login rejects default as a reserved account name", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx, notifications } = createInteractiveAccountContext(
		{ model: { provider: "openai-codex", id: "codex" }, modelRegistry: registry },
		{ selections: ["Login new account", "OpenAI Codex"], inputs: ["default"] },
	);

	await mock.commands.get("accounts")?.handler("ignored", ctx);

	assert.equal((await store.readProviderAsync("openai-codex")).accounts.default, undefined);
	assert.match(notifications.at(-1)?.message ?? "", /reserved/);
});

test("login asks before replacing an existing account name", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: { "openai-codex": { active: "work", accounts: { work: credential("old") } } },
	});
	let logins = 0;
	const codex = fakeProvider("openai-codex");
	codex.oauth.login = async () => {
		logins += 1;
		return credential("new");
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex],
	});
	const { registry } = runtimeHarness(mock);
	const cancelled = createInteractiveAccountContext(
		{ model: { provider: "openai-codex", id: "codex" }, modelRegistry: registry },
		{ selections: ["Login new account", "OpenAI Codex"], inputs: ["work"], confirms: [false] },
	);

	await mock.commands.get("accounts")?.handler("ignored", cancelled.ctx);
	assert.equal(logins, 0);
	assert.equal((await store.readProviderAsync("openai-codex")).accounts.work?.access, "access-old");
	assert.match(cancelled.confirmCalls[0]?.message ?? "", /already exists/);

	const replaced = createInteractiveAccountContext(
		{ model: { provider: "openai-codex", id: "codex" }, modelRegistry: registry },
		{ selections: ["Login new account", "OpenAI Codex"], inputs: ["work"], confirms: [true] },
	);
	await mock.commands.get("accounts")?.handler("ignored", replaced.ctx);
	assert.equal(logins, 1);
	assert.equal((await store.readProviderAsync("openai-codex")).accounts.work?.access, "access-new");
});

test("login selects a provider default model only when the current model is unknown", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	const codex = fakeProvider("openai-codex");
	codex.defaultModelId = "codex";
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx } = createInteractiveAccountContext(
		{
			model: { provider: "unknown", id: "unknown", api: "unknown" },
			modelRegistry: registry,
		},
		{ selections: ["Login new account", "OpenAI Codex"], inputs: ["work"] },
	);

	await mock.commands.get("accounts")?.handler("ignored", ctx);

	assert.equal(mock.setModels.length, 1);
});

test("OpenAI Codex activation applies its endpoint and available model projection, then restores config", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "enterprise",
				accounts: {
					enterprise: credential("codex", { availableModelIds: ["allowed"] }),
				},
			},
		},
	});
	const mock = createMockPi();
	mock.rawPi.registerProvider("openai-codex", { headers: { Existing: "yes" } });
	const provider = fakeProvider("openai-codex", {
		baseUrl: "https://api.codex.example",
		headers: { Account: "enterprise" },
	});
	const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	const result = await coordinator.ensureActive(ctx, store);
	assert.deepEqual(result, {
		status: "active",
		providerId: "openai-codex",
		accountName: "enterprise",
	});
	assert.equal(keys.get("openai-codex"), "access-codex");
	const projected = mock.providers.get("openai-codex") as {
		headers: Record<string, string>;
		baseUrl: string;
		models: Array<{ id: string }>;
	};
	assert.deepEqual(projected.headers, { Existing: "yes", Account: "enterprise" });
	assert.equal(projected.baseUrl, "https://api.codex.example");
	assert.deepEqual(
		projected.models.map((model) => model.id),
		["allowed"],
	);

	await store.updateProvider("openai-codex", (state) => ({ ...state, active: undefined }));
	await coordinator.ensureActive(ctx, store);
	assert.deepEqual(mock.providers.get("openai-codex"), { headers: { Existing: "yes" } });
	assert.equal(keys.has("openai-codex"), false);
});

test("Codex account switches rebuild model filtering from the complete pre-overlay catalog", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "first",
				accounts: {
					first: credential("first", { availableModelIds: ["allowed"] }),
					second: credential("second", { availableModelIds: ["blocked"] }),
				},
			},
		},
	});
	const mock = createMockPi();
	const provider = fakeProvider("openai-codex", { baseUrl: "https://api.codex.example" });
	const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
	const { registry } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	await coordinator.ensureActive(ctx, store);
	assert.deepEqual(
		(mock.providers.get("openai-codex") as { models: Array<{ id: string }> }).models.map(
			(model) => model.id,
		),
		["allowed"],
	);
	await store.updateProvider("openai-codex", (state) => ({ ...state, active: "second" }));
	await coordinator.ensureActive(ctx, store);
	assert.deepEqual(
		(mock.providers.get("openai-codex") as { models: Array<{ id: string }> }).models.map(
			(model) => model.id,
		),
		["blocked"],
	);
});

test("unsafe provider endpoints and malformed model metadata fail closed", async () => {
	await Promise.all(
		(["endpoint", "models"] as const).map(async (mode) => {
			const store = new AccountStore(new InMemoryAccountStorageBackend());
			await store.write({
				version: 1,
				providers: {
					"openai-codex": {
						active: "work",
						accounts: {
							work: credential("codex", mode === "models" ? { availableModelIds: [1] } : {}),
						},
					},
				},
			});
			const provider = fakeProvider("openai-codex", {
				baseUrl: mode === "endpoint" ? "http://token-stealer.invalid" : undefined,
			});
			const mock = createMockPi();
			const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
			const { registry, keys } = runtimeHarness(mock);
			const { ctx } = createMockContext({ modelRegistry: registry });

			assert.equal((await coordinator.ensureActive(ctx, store)).status, "error");
			assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
		})
	);
});

test("invalid refreshed credentials fail closed instead of escaping storage validation", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "work",
				accounts: { work: { ...credential("expired"), expires: 1 } },
			},
		},
	});
	const provider = fakeProvider("openai-codex");
	provider.oauth.refresh = async () => ({
		type: "oauth",
		access: "",
		refresh: "rotated-secret",
		expires: Date.now() + 60_000,
	});
	const mock = createMockPi();
	const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	const result = await coordinator.ensureActive(ctx, store);
	assert.equal(result.status, "error");
	assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
	assert.equal(
		(await store.readProviderAsync("openai-codex")).accounts.work?.access,
		"access-expired",
	);
});

test("fail-closed runtime keys are attempted even when a provider overlay is rejected", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "work",
				accounts: { work: credential("codex") },
			},
		},
	});
	const mock = createMockPi();
	const pi = {
		...mock.rawPi,
		registerProvider() {
			throw new Error("overlay rejected");
		},
	} as never;
	const coordinator = new RuntimeAuthCoordinator(pi, fakeProvider("openai-codex"));
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	const result = await coordinator.ensureActive(ctx, store);
	assert.equal(result.status, "error");
	assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
});

test("refresh and auth derivation failures fail closed and redact secrets", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("secret") } },
		},
	});
	const failing = fakeProvider("openai-codex");
	failing.oauth.toAuth = async (current) => {
		throw new Error(`bad ${current.access} and ${current.refresh}`);
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [failing],
	});
	const { registry, keys } = runtimeHarness(mock);
	let aborts = 0;
	const { ctx, statuses } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
		abort: () => {
			aborts += 1;
		},
	});

	await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
	assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
	assert.match(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/);
	assert.doesNotMatch(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /access-secret|refresh-secret/);
	await mock.events.get("turn_start")?.[0]?.({}, ctx);
	assert.equal(aborts, 1);
});

test("account reset during OAuth conversion cannot restore a stale runtime override", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("codex") } },
		},
	});
	let releaseConversion: (() => void) | undefined;
	const conversionBlocked = new Promise<void>((resolve) => {
		releaseConversion = resolve;
	});
	let signalConversion: (() => void) | undefined;
	const conversionStarted = new Promise<void>((resolve) => {
		signalConversion = resolve;
	});
	const codex = fakeProvider("openai-codex");
	codex.oauth.toAuth = async (current) => {
		signalConversion?.();
		await conversionBlocked;
		return { apiKey: current.access };
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
	await conversionStarted;
	const resetContext = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Switch OpenAI Codex account", "default"] },
	).ctx;
	const reset = mock.commands.get("accounts")?.handler("ignored", resetContext);
	releaseConversion?.();
	await Promise.all([startup, reset]);
	assert.equal((await store.readProviderAsync("openai-codex")).active, undefined);
	assert.equal(keys.has("openai-codex"), false);
});

test("an overlapping account switch reports when its requested account was superseded", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				accounts: { alpha: credential("alpha"), beta: credential("beta") },
			},
		},
	});
	let releaseAlpha: (() => void) | undefined;
	const alphaBlocked = new Promise<void>((resolve) => {
		releaseAlpha = resolve;
	});
	let signalAlpha: (() => void) | undefined;
	const alphaStarted = new Promise<void>((resolve) => {
		signalAlpha = resolve;
	});
	const codex = fakeProvider("openai-codex");
	codex.oauth.toAuth = async (current) => {
		if (current.access === "access-alpha") {
			signalAlpha?.();
			await alphaBlocked;
		}
		return { apiKey: current.access };
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex],
	});
	const { registry } = runtimeHarness(mock);
	const olderContext = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Switch OpenAI Codex account", "alpha"] },
	);
	const newerContext = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Switch OpenAI Codex account", "beta"] },
	);

	const older = mock.commands.get("accounts")?.handler("ignored", olderContext.ctx);
	await alphaStarted;
	await mock.commands.get("accounts")?.handler("ignored", newerContext.ctx);
	releaseAlpha?.();
	await older;

	assert.equal((await store.readProviderAsync("openai-codex")).active, "beta");
	assert.match(olderContext.notifications.at(-1)?.message ?? "", /alpha.*superseded/);
});

test("remove account confirms and active removal restores default provider auth", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "work",
				accounts: { personal: credential("personal"), work: credential("work") },
			},
		},
	});
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex")],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx, confirmCalls } = createInteractiveAccountContext(
		{
			model: { provider: "openai-codex", id: "codex" },
			modelRegistry: registry,
		},
		{ selections: ["Remove account", "OpenAI Codex · work"], confirms: [true] },
	);

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.equal(keys.get("openai-codex"), "access-work");
	await mock.commands.get("accounts")?.handler("ignored", ctx);

	const state = await store.readProviderAsync("openai-codex");
	assert.equal(state.active, undefined);
	assert.equal(state.accounts.work, undefined);
	assert.equal(state.accounts.personal?.access, "access-personal");
	assert.equal(keys.has("openai-codex"), false);
	assert.match(confirmCalls[0]?.message ?? "", /Remove OpenAI Codex account "work"/);
});
