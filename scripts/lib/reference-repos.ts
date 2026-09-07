/**
 * Manifest of vendored reference repositories.
 *
 * Add a new entry to vendor another repository into this workspace:
 *   - id:                 short identifier used by `--repo <id>`
 *   - repository:         git remote URL to sync from
 *   - prefix:             directory the subtree is vendored into
 *   - latestRef:          branch/ref used by `--latest`
 *   - versionSourcePath:  workspace-relative file that pins the version in use
 *   - packageVersionPath: key path into that file (JSON only)
 *   - versionTagPrefix:   upstream tag prefix for that version, e.g. "effect@"
 *
 * Without `--latest`, the pinned ref is resolved as
 * `<versionTagPrefix><version>` read from `versionSourcePath`.
 */

export interface ReferenceRepo {
   readonly id: string;
   readonly repository: string;
   readonly prefix: string;
   readonly latestRef: string;
   readonly versionSourcePath: string;
   readonly packageVersionPath: ReadonlyArray<string>;
   readonly versionTagPrefix: string;
}

export const referenceRepos: ReadonlyArray<ReferenceRepo> = [
   {
      id: "effect",
      repository: "https://github.com/Effect-TS/effect.git",
      prefix: "repos/effect",
      latestRef: "main",
      versionSourcePath: "extensions/pi-subagent/package.json",
      packageVersionPath: ["dependencies", "effect"],
      versionTagPrefix: "effect@"
   }
];
