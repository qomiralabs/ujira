// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where routing documents live. Versions are immutable once written, and one
// pointer names the active version, so activating or rolling back is a
// single write that readers see whole or not at all. The database
// implementation belongs to the db package; the in-memory one below serves
// tests and local runs.

export interface StoreCallOptions {
  /** Aborted when the caller's timeout fires. */
  readonly signal: AbortSignal;
}

export interface RoutingConfigVersionRecord {
  readonly version: number;
  /** The document exactly as written, before parsing. */
  readonly document: unknown;
  /** The operator who wrote it, as an opaque ID. */
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface RoutingConfigStore {
  /** Stores a new immutable version and returns its number. Never activates it. */
  insertVersion(
    input: { readonly document: unknown; readonly createdBy: string },
    opts: StoreCallOptions,
  ): Promise<{ readonly version: number }>;
  getVersion(version: number, opts: StoreCallOptions): Promise<RoutingConfigVersionRecord | null>;
  /** Points the active pointer at an existing version in one write. */
  activate(version: number, opts: StoreCallOptions): Promise<void>;
  /** The active version number, or null when none was ever activated. Cheap: read every poll. */
  readActivePointer(opts: StoreCallOptions): Promise<number | null>;
}

export interface MemoryRoutingConfigStore extends RoutingConfigStore {
  /**
   * Moves the pointer without the checks activation makes, as a database
   * edit by hand or a version written under an older schema would. Tests
   * use it to prove a bad active version cannot take effect.
   */
  forceActive(version: number): void;
}

export function createMemoryRoutingConfigStore(
  now: () => Date = () => new Date(),
): MemoryRoutingConfigStore {
  const versions = new Map<number, RoutingConfigVersionRecord>();
  let active: number | null = null;

  const requireVersion = (version: number): RoutingConfigVersionRecord => {
    const record = versions.get(version);
    if (record === undefined) throw new RangeError('no such routing configuration version');
    return record;
  };

  return {
    insertVersion({ document, createdBy }) {
      const version = versions.size + 1;
      // A copy, so a caller changing its object later cannot change history.
      const record = Object.freeze({
        version,
        document: structuredClone(document),
        createdBy,
        createdAt: now(),
      });
      versions.set(version, record);
      return Promise.resolve({ version });
    },
    getVersion(version) {
      const record = versions.get(version);
      if (record === undefined) return Promise.resolve(null);
      return Promise.resolve({ ...record, document: structuredClone(record.document) });
    },
    activate(version) {
      if (!versions.has(version)) {
        return Promise.reject(new RangeError('no such routing configuration version'));
      }
      active = version;
      return Promise.resolve();
    },
    readActivePointer() {
      return Promise.resolve(active);
    },
    forceActive(version) {
      requireVersion(version);
      active = version;
    },
  };
}
