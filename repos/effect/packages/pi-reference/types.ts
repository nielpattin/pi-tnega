/**
 * Type definitions for pi-reference.
 */

/** A local directory reference. */
export interface LocalSource {
   type: "local";
   /** Absolute resolved path. */
   path: string;
   description?: string;
   hidden?: boolean;
}

/** A Git repository reference. */
export interface GitSource {
   type: "git";
   /** Repository identifier: owner/repo, full URL, or SSH URL. */
   repository: string;
   branch?: string;
   description?: string;
   hidden?: boolean;
}

/** Union of all reference source types. */
export type Source = LocalSource | GitSource;

/** Config entry form: string shorthand or object. */
export type ReferenceEntry = string | LocalEntryConfig | GitEntryConfig;

export interface LocalEntryConfig {
   path: string;
   description?: string;
   hidden?: boolean;
}

export interface GitEntryConfig {
   repository: string;
   branch?: string;
   description?: string;
   hidden?: boolean;
}

/** Resolved reference: has a concrete filesystem path. */
export interface ReferenceInfo {
   name: string;
   /** Absolute resolved path (local dir or git cache path). */
   path: string;
   description?: string;
   hidden?: boolean;
   source: Source;
}
