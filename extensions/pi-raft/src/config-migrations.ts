export const CURRENT_RAFT_CONFIG_VERSION = 5;

export interface RaftConfigMigrationResult {
  document: Record<string, unknown>;
  fromVersion: number;
  toVersion: number;
  appliedVersions: number[];
  changed: boolean;
  // True when the document was written by a newer pi-raft build. The document
  // is accepted as-is (newer builds only add semantics older builds can safely
  // ignore) and is never rewritten or version-stamped down.
  forwardCompatible: boolean;
}

interface RaftConfigMigration {
  from: number;
  to: number;
  migrate(document: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isObject(current) && isObject(value) ? mergeObjects(current, value) : value;
  }
  return merged;
};

const migrations: readonly RaftConfigMigration[] = [
  {
    from: 0,
    to: 1,
    migrate(document) {
      const migrated = { ...document };
      const legacy = migrated.subagents;
      const canonical = migrated.agents;
      if (legacy !== undefined) {
        if (canonical !== undefined && isObject(legacy) !== isObject(canonical)) {
          throw new Error(
            "Raft configuration cannot merge legacy subagents with a malformed agents section",
          );
        }
        migrated.agents =
          isObject(legacy) && isObject(canonical)
            ? mergeObjects(legacy, canonical)
            : (canonical ?? legacy);
      }
      delete migrated.subagents;
      return migrated;
    },
  },
  {
    from: 1,
    to: 2,
    migrate(document) {
      const migrated = { ...document };
      const ui = migrated.ui;
      if (isObject(ui) && Object.hasOwn(ui, "showNestedToolCalls")) {
        const renamed = { ...ui };
        if (!Object.hasOwn(renamed, "showAgentToolPreview")) {
          renamed.showAgentToolPreview = renamed.showNestedToolCalls;
        }
        delete renamed.showNestedToolCalls;
        migrated.ui = renamed;
      }
      return migrated;
    },
  },
  {
    from: 2,
    to: 3,
    migrate(document) {
      const migrated = { ...document };
      const ui = migrated.ui;
      if (isObject(ui) && Object.hasOwn(ui, "nestedToolDebounceMs")) {
        const renamed = { ...ui };
        if (!Object.hasOwn(renamed, "updateDebounceMs")) {
          renamed.updateDebounceMs = renamed.nestedToolDebounceMs;
        }
        delete renamed.nestedToolDebounceMs;
        migrated.ui = renamed;
      }
      return migrated;
    },
  },
  {
    from: 3,
    to: 4,
    migrate(document) {
      return { ...document };
    },
  },
  {
    from: 4,
    to: 5,
    migrate(document) {
      const migrated = { ...document };
      // These three settings were accepted at both the nested runtime path and
      // a legacy top-level path; drop every occurrence so no stale key lingers.
      delete migrated.fullCodeMode;
      delete migrated.excludeCoreTools;
      delete migrated.capture;
      const execution = migrated.execution;
      if (isObject(execution) && Object.hasOwn(execution, "fullCodeMode")) {
        const next = { ...execution };
        delete next.fullCodeMode;
        migrated.execution = next;
      }
      const tools = migrated.tools;
      if (isObject(tools)) {
        const next = { ...tools };
        delete next.excludeCoreTools;
        delete next.capture;
        migrated.tools = next;
      }
      return migrated;
    },
  },
];

const configVersion = (document: Readonly<Record<string, unknown>>): number => {
  const value = document.configVersion;
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Raft configuration configVersion must be a non-negative integer");
  }
  return value;
};

export const migrateRaftConfigDocument = (
  input: Readonly<Record<string, unknown>>,
): RaftConfigMigrationResult => {
  const fromVersion = configVersion(input);
  if (fromVersion > CURRENT_RAFT_CONFIG_VERSION) {
    // Written by a newer build: accept as-is instead of bricking the
    // extension. Legacy-shape checks (e.g. the removed subagents key) apply to
    // supported versions only — newer semantics are unknown here.
    return {
      document: structuredClone(input) as Record<string, unknown>,
      fromVersion,
      toVersion: fromVersion,
      appliedVersions: [],
      changed: false,
      forwardCompatible: true,
    };
  }
  let version = fromVersion;
  let document = structuredClone(input) as Record<string, unknown>;
  const appliedVersions: number[] = [];

  while (version < CURRENT_RAFT_CONFIG_VERSION) {
    const migration = migrations.find((candidate) => candidate.from === version);
    if (!migration || migration.to !== version + 1) {
      throw new Error(`No Raft configuration migration exists for version ${version}`);
    }
    document = migration.migrate(document);
    version = migration.to;
    document.configVersion = version;
    appliedVersions.push(version);
  }

  if (Object.hasOwn(document, "subagents")) {
    throw new Error("Current Raft configuration contains removed key subagents");
  }

  return {
    document,
    fromVersion,
    toVersion: version,
    appliedVersions,
    changed: appliedVersions.length > 0,
    forwardCompatible: false,
  };
};
