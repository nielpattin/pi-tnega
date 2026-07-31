import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import lockfile from "proper-lockfile";
import {
	ACCOUNTS_FILE,
	AccountStore,
	migrateLegacyCodexAccountsFile,
	parseAccountsData,
} from "../src/accounts.js";
import { FileAccountStorageBackend, InMemoryAccountStorageBackend } from "../src/storage.js";

const credential = (suffix: string, extra: Record<string, unknown> = {}) => ({
	type: "oauth" as const,
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: 2_000_000_000_000,
	...extra,
});

// Windows exposes no Unix permission bits: Node's chmod only toggles the
// read-only attribute, so lstat().mode reports 0o666 regardless.
const isWindows = process.platform === "win32";

async function assertMode(file: string, expected: number): Promise<void> {
	if (isWindows) return;
	assert.equal((await lstat(file)).mode & 0o777, expected);
}

test("provider-scoped storage preserves active accounts and OAuth metadata", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "work",
				accounts: {
					work: credential("codex", { accountId: "acct-1", optionalMetadata: undefined }),
					personal: credential("personal", { accountId: "acct-2" }),
				},
			},
		},
	});

	const stored = await store.readAsync();
	assert.equal(stored.providers["openai-codex"]?.active, "work");
	assert.equal(
		Object.hasOwn(stored.providers["openai-codex"]?.accounts.work ?? {}, "optionalMetadata"),
		false,
	);
	assert.equal(stored.providers["openai-codex"]?.accounts.personal?.accountId, "acct-2");
});

test("parsed provider and account maps treat prototype-like names as own properties", () => {
	const parsed = parseAccountsData(
		JSON.stringify({
			version: 1,
			providers: {
				"openai-codex": {
					active: "constructor",
					accounts: JSON.parse(
						`{"__proto__":{"type":"oauth","access":"a","refresh":"r","expires":1},"constructor":{"type":"oauth","access":"b","refresh":"s","expires":2}}`,
					),
				},
			},
		}),
	);

	const accounts = parsed.providers["openai-codex"]?.accounts;
	assert.ok(accounts);
	assert.equal(Object.hasOwn(accounts, "__proto__"), true);
	assert.equal(Object.hasOwn(accounts, "constructor"), true);
	const constructorCredential = Object.getOwnPropertyDescriptor(accounts, "constructor")?.value as
		| { access?: string }
		| undefined;
	assert.equal(constructorCredential?.access, "b");
	assert.equal(Object.getPrototypeOf(accounts), null);
	assert.equal(Object.getPrototypeOf(parsed.providers), null);
});

test("storage rejects malformed credentials and non-JSON-safe metadata", async () => {
	assert.throws(
		() =>
			parseAccountsData(
				JSON.stringify({
					version: 1,
					providers: { "openai-codex": { accounts: { work: { access: "a", expires: 1 } } } },
				}),
			),
		/missing refresh token/,
	);

	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await assert.rejects(
		store.write({
			version: 1,
			providers: {
				"openai-codex": {
					accounts: {
						work: {
							...credential("bad"),
							metadata: () => undefined,
						},
					},
				},
			},
		}),
		/not JSON-safe/,
	);
});

test("missing account storage reads as empty without materializing its directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-accounts-store-missing-"));
	const agentDir = join(root, "agent");
	const file = join(agentDir, ACCOUNTS_FILE);
	try {
		const store = new AccountStore(new FileAccountStorageBackend(file));
		const loadedSync = store.read();
		const loadedAsync = await store.readAsync();
		assert.equal(loadedSync.version, 1);
		assert.deepEqual(Object.keys(loadedSync.providers), []);
		assert.deepEqual(loadedAsync, loadedSync);
		assert.equal(existsSync(agentDir), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("account storage keeps the previous version's default lock path", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-compatible-lock-"));
	const file = join(dir, ACCOUNTS_FILE);
	const legacyLock = `${file}.lock`;
	try {
		await mkdir(legacyLock);
		const backend = new FileAccountStorageBackend(file);
		let entered = false;
		const write = backend.withLockAsync(async () => {
			entered = true;
			return { result: undefined, next: "published" };
		});

		await new Promise((resolve) => setTimeout(resolve, 25));
		const enteredWhileLegacyLockHeld = entered;
		await rm(legacyLock, { recursive: true });
		await write;

		assert.equal(enteredWhileLegacyLockHeld, false);
		assert.equal(await readFile(file, "utf8"), "published");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("sync missing account reads wait on an existing default lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-compatible-sync-lock-"));
	const file = join(dir, ACCOUNTS_FILE);
	try {
		await mkdir(`${file}.lock`);
		const backend = new FileAccountStorageBackend(file, { syncLockTimeoutMs: 20 });
		let entered = false;

		assert.throws(
			() =>
				backend.read(() => {
					entered = true;
				}),
			(error: unknown) => error instanceof Error && "code" in error && error.code === "ELOCKED",
		);
		assert.equal(entered, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("missing account reads wait for an in-progress first write", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-first-write-"));
	const file = join(dir, ACCOUNTS_FILE);
	try {
		const backend = new FileAccountStorageBackend(file);
		let allowWrite: () => void = () => undefined;
		const writeAllowed = new Promise<void>((resolve) => {
			allowWrite = resolve;
		});
		let markWriteEntered: () => void = () => undefined;
		const writeEntered = new Promise<void>((resolve) => {
			markWriteEntered = resolve;
		});
		const write = backend.withLockAsync(async () => {
			markWriteEntered();
			await writeAllowed;
			return { result: undefined, next: "published" };
		});
		await writeEntered;

		let readSettled = false;
		const read = backend
			.readAsync(async (current) => current)
			.finally(() => {
				readSettled = true;
			});
		await new Promise((resolve) => setImmediate(resolve));
		const settledWhileWriteHeld = readSettled;
		allowWrite();
		await write;

		assert.equal(settledWhileWriteHeld, false);
		assert.equal(await read, "published");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("async account reads reject contained lock compromise errors", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-compromised-read-"));
	const file = join(dir, ACCOUNTS_FILE);
	try {
		await writeFile(file, "published", { mode: 0o600 });
		const backend = new FileAccountStorageBackend(file);
		const lockOwner = backend as unknown as {
			acquireLockAsync(onCompromised?: (error: Error) => void): Promise<() => Promise<void>>;
		};
		lockOwner.acquireLockAsync = (onCompromised) =>
			lockfile.lock(file, {
				realpath: false,
				stale: 2_000,
				update: 1_000,
				...(onCompromised ? { onCompromised } : {}),
			});
		let markReaderEntered: () => void = () => undefined;
		const readerEntered = new Promise<void>((resolve) => {
			markReaderEntered = resolve;
		});
		const read = backend.readAsync(async () => {
			markReaderEntered();
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			return "read";
		});
		await readerEntered;
		await rm(`${file}.lock`, { recursive: true });

		await assert.rejects(read, (error: unknown) => {
			return error instanceof Error && "code" in error && error.code === "ECOMPROMISED";
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("file storage creates private files and serializes concurrent updates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-"));
	const file = join(dir, ACCOUNTS_FILE);
	try {
		const first = new AccountStore(new FileAccountStorageBackend(file));
		const second = new AccountStore(new FileAccountStorageBackend(file));
		await Promise.all([
			first.update((data) => ({
				...data,
				providers: {
					...data.providers,
					"openai-codex": {
						active: "work",
						accounts: {
							...data.providers["openai-codex"]?.accounts,
							work: credential("work"),
						},
					},
				},
			})),
			second.update((data) => ({
				...data,
				providers: {
					...data.providers,
					"openai-codex": {
						active: "home",
						accounts: {
							...data.providers["openai-codex"]?.accounts,
							home: credential("home"),
						},
					},
				},
			})),
		]);

		const stored = await first.readAsync();
		assert.equal(stored.providers["openai-codex"]?.active, "home");
		assert.ok(stored.providers["openai-codex"]?.accounts.work);
		assert.ok(stored.providers["openai-codex"]?.accounts.home);
		await assertMode(file, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("file storage rejects symlinks without reading or changing their targets", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-symlink-"));
	const target = join(dir, "target.json");
	const file = join(dir, ACCOUNTS_FILE);
	try {
		await writeFile(target, JSON.stringify({ version: 1, providers: {} }), { mode: 0o644 });
		await symlink(target, file);
		const store = new AccountStore(new FileAccountStorageBackend(file));

		await assert.rejects(store.readAsync(), /regular file/);
		await assertMode(target, 0o644);
		assert.equal(await readFile(target, "utf8"), JSON.stringify({ version: 1, providers: {} }));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("file storage repairs weakened credential permissions on every read", { skip: isWindows }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-permissions-"));
	const file = join(dir, ACCOUNTS_FILE);
	try {
		const store = new AccountStore(new FileAccountStorageBackend(file));
		await store.write({ version: 1, providers: {} });
		await chmod(file, 0o644);

		await store.readAsync();
		assert.equal((await lstat(file)).mode & 0o777, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("migration copies released Codex schema into provider state and retains rollback source", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-migrate-"));
	const legacy = join(dir, "pi-codex-accounts.json");
	const canonical = join(dir, ACCOUNTS_FILE);
	try {
		await writeFile(
			legacy,
			JSON.stringify({
				active: "work",
				accounts: { work: credential("work", { accountId: "acct" }) },
			}),
			{ mode: 0o644 },
		);
		const result = await migrateLegacyCodexAccountsFile(legacy, canonical);

		assert.equal(result.status, "migrated");
		await assertMode(legacy, 0o600);
		await assertMode(canonical, 0o600);
		assert.ok((await readFile(legacy, "utf8")).includes("access-work"));
		const migrated = parseAccountsData(await readFile(canonical, "utf8"));
		assert.equal(migrated.providers["openai-codex"]?.active, "work");
		assert.equal(migrated.providers["openai-codex"]?.accounts.work?.accountId, "acct");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("concurrent migrations serialize and install one complete canonical file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-concurrent-migration-"));
	const legacy = join(dir, "pi-codex-accounts.json");
	const canonical = join(dir, ACCOUNTS_FILE);
	try {
		await writeFile(
			legacy,
			JSON.stringify({ active: "work", accounts: { work: credential("work") } }),
			{ mode: 0o600 },
		);
		const results = await Promise.all([
			migrateLegacyCodexAccountsFile(legacy, canonical),
			migrateLegacyCodexAccountsFile(legacy, canonical),
		]);
		assert.deepEqual(results.map((result) => result.status).toSorted(), ["canonical", "migrated"]);
		assert.equal(
			parseAccountsData(await readFile(canonical, "utf8")).providers["openai-codex"]?.active,
			"work",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("migration recovers from stale interrupted temporary files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-interrupted-migration-"));
	const legacy = join(dir, "pi-codex-accounts.json");
	const canonical = join(dir, ACCOUNTS_FILE);
	const staleTemp = join(dir, `.${ACCOUNTS_FILE}.interrupted.tmp`);
	try {
		await writeFile(
			legacy,
			JSON.stringify({ active: "work", accounts: { work: credential("work") } }),
			{ mode: 0o600 },
		);
		await writeFile(staleTemp, "partial secret", { mode: 0o600 });
		const old = new Date(Date.now() - 60_000);
		await utimes(staleTemp, old, old);

		assert.equal((await migrateLegacyCodexAccountsFile(legacy, canonical)).status, "migrated");
		await assert.rejects(lstat(staleTemp), /ENOENT/);
		assert.equal(
			parseAccountsData(await readFile(canonical, "utf8")).providers["openai-codex"]?.active,
			"work",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("migration rejects symlink credential paths without changing their targets", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-symlink-"));
	const target = join(dir, "target.json");
	const legacy = join(dir, "pi-codex-accounts.json");
	const canonical = join(dir, ACCOUNTS_FILE);
	try {
		await writeFile(
			target,
			JSON.stringify({ active: "old", accounts: { old: credential("old") } }),
		);
		await symlink(target, legacy);
		await assert.rejects(migrateLegacyCodexAccountsFile(legacy, canonical), /regular file/);
		assert.ok((await readFile(target, "utf8")).includes("access-old"));
		await assert.rejects(readFile(canonical, "utf8"), /ENOENT/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("migration gives an existing canonical file precedence without rewriting it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-precedence-"));
	const legacy = join(dir, "pi-codex-accounts.json");
	const canonical = join(dir, ACCOUNTS_FILE);
	try {
		await writeFile(
			legacy,
			JSON.stringify({ active: "old", accounts: { old: credential("old") } }),
		);
		await writeFile(canonical, JSON.stringify({ version: 1, providers: {} }));
		await chmod(canonical, 0o644);

		const result = await migrateLegacyCodexAccountsFile(legacy, canonical);
		assert.equal(result.status, "canonical");
		assert.deepEqual(parseAccountsData(await readFile(canonical, "utf8")), {
			version: 1,
			providers: Object.assign(Object.create(null), {}),
		});
		await assertMode(canonical, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
