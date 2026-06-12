/**
 * ============================================================================
 *  FAKE-INDEXEDDB → DISK PERSISTENCE (the "save the keys to a file" seam)
 * ============================================================================
 *
 * matrix-js-sdk's rust-crypto WASM persists its keys (device identity,
 * cross-signing, Olm/Megalm sessions) to **IndexedDB** — a *browser* API.
 * Under `bun --compile` there is no IndexedDB, so without a polyfill
 * `initRustCrypto({ cryptoDatabasePrefix })` fails with "indexedDB getter
 * returned null".
 *
 * `fake-indexeddb` is the polyfill the matrix-js-sdk team officially ships for
 * Node — it implements IndexedDB transaction semantics CORRECTLY (unlike
 * indexeddbshim, which deadlocks the rust-crypto migrations). Its one gap: it
 * is **in-memory only**, so a daemon restart would wipe the crypto store and
 * the bot would re-register as a brand-new device every boot — device-list
 * spam, and it can't read history written before the restart.
 *
 * This module closes that gap. It:
 *
 *   1. Installs fake-indexeddb's factory + key-range as the global
 *      `indexedDB` / `IDBKeyRange` (what the WASM reaches for).
 *   2. On boot, RESTORES the entire IndexedDB state from a single on-disk
 *      snapshot file (Andrew's "save it to a bin file" — it literally is one,
 *      `v8.serialize`d so binary key material survives).
 *   3. After every read-write transaction completes, schedules a DEBOUNCED
 *      snapshot back to that file. So the device identity + sessions survive
 *      restarts → STABLE DEVICE, no churn, decryptable history.
 *
 * The snapshot/restore walks ONLY the public IndexedDB API (databases(),
 * objectStore schema, getAll/getAllKeys) so it is robust across fake-indexeddb
 * internal changes — it never touches the BinarySearchTree internals.
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { log } from "../../lib/logger.ts";

/**
 * Stable IndexedDB database-name prefix passed to `initRustCrypto`. Because the
 * store is now in-memory (fake-indexeddb) + snapshotted to disk, the prefix is
 * just a namespace — but it MUST be identical at setup, runtime, and notify
 * time, or a process would look up a DB name that doesn't match the restored
 * snapshot and silently start with an empty (new-device) store. One constant,
 * used everywhere, removes that footgun.
 */
export const MATRIX_CRYPTO_DB_PREFIX = "phantombot-crypto";

/** Per-persona snapshot file: lives inside the crypto store dir (which sits
 *  next to SOUL.md), so it migrates with the persona like the rest. */
export function cryptoSnapshotPath(cryptoStoreDir: string): string {
  return join(cryptoStoreDir, "idb-snapshot.bin");
}

/** One object store's schema + contents. */
interface StoreDump {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: {
    name: string;
    keyPath: string | string[];
    unique: boolean;
    multiEntry: boolean;
  }[];
  /** Parallel arrays: keys[i] is the primary key of values[i]. */
  keys: unknown[];
  values: unknown[];
}

/** One database: name, version, and every object store. */
interface DbDump {
  name: string;
  version: number;
  stores: StoreDump[];
}

interface Snapshot {
  version: 1;
  dbs: DbDump[];
}

let snapshotPath: string | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotInFlight = false;
let snapshotQueued = false;

/** Debounce window after the last write before we serialise to disk. */
const SNAPSHOT_DEBOUNCE_MS = 400;

/**
 * Install fake-indexeddb globals and restore the crypto store from `path`.
 * Call ONCE before the first `initRustCrypto`. Idempotent per process.
 */
export async function installPersistentIndexedDB(
  path: string,
  opts: { readOnly?: boolean; fresh?: boolean } = {},
): Promise<void> {
  // readOnly restores the device identity but never writes back. Used by the
  // short-lived notify process so it reuses the bot's device WITHOUT racing the
  // long-running listener for ownership of the snapshot file.
  snapshotPath = opts.readOnly ? null : path;

  // fresh: discard any existing snapshot and start from an EMPTY store. Used at
  // setup time — a password login always mints a NEW device id, so the crypto
  // store must be bound to that new device; restoring a previous device's store
  // would mismatch ("account in the store doesn't match the constructor"). The
  // new device is snapshotted as setup writes it.
  if (opts.fresh && existsSync(path)) {
    try {
      const { rmSync } = await import("node:fs");
      rmSync(path, { force: true });
      log.info("matrix: cleared stale crypto snapshot for fresh setup", { path });
    } catch {
      /* best-effort */
    }
  }

  // Dynamic import: only an E2EE Matrix account pays the cost. The rust-crypto
  // store reaches for the FULL set of IDB globals (cursors, transactions, key
  // ranges) via globalThis — registering only `indexedDB`/`IDBKeyRange` makes
  // its cursor marshalling throw "Dynamic cast failed". So we register the same
  // surface `fake-indexeddb/auto` does, but keep a handle on the factory for
  // snapshot/restore. Each module is the SAME singleton `/auto` would install.
  const [
    { default: FDBFactory },
    { default: FDBKeyRange },
    { default: FDBDatabase },
    { default: FDBCursor },
    { default: FDBCursorWithValue },
    { default: FDBIndex },
    { default: FDBObjectStore },
    { default: FDBOpenDBRequest },
    { default: FDBRequest },
    { default: FDBTransaction },
    { default: FDBVersionChangeEvent },
  ] = await Promise.all([
    import("fake-indexeddb/lib/FDBFactory"),
    import("fake-indexeddb/lib/FDBKeyRange"),
    import("fake-indexeddb/lib/FDBDatabase"),
    import("fake-indexeddb/lib/FDBCursor"),
    import("fake-indexeddb/lib/FDBCursorWithValue"),
    import("fake-indexeddb/lib/FDBIndex"),
    import("fake-indexeddb/lib/FDBObjectStore"),
    import("fake-indexeddb/lib/FDBOpenDBRequest"),
    import("fake-indexeddb/lib/FDBRequest"),
    import("fake-indexeddb/lib/FDBTransaction"),
    import("fake-indexeddb/lib/FDBVersionChangeEvent"),
  ]);

  const factory = new FDBFactory();
  const g = globalThis as Record<string, unknown>;
  const def = (value: unknown) => ({
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperties(g, {
    indexedDB: def(factory),
    IDBKeyRange: def(FDBKeyRange),
    IDBFactory: def(FDBFactory),
    IDBDatabase: def(FDBDatabase),
    IDBCursor: def(FDBCursor),
    IDBCursorWithValue: def(FDBCursorWithValue),
    IDBIndex: def(FDBIndex),
    IDBObjectStore: def(FDBObjectStore),
    IDBOpenDBRequest: def(FDBOpenDBRequest),
    IDBRequest: def(FDBRequest),
    IDBTransaction: def(FDBTransaction),
    IDBVersionChangeEvent: def(FDBVersionChangeEvent),
  });

  // Hook every read-write transaction's completion to trigger a debounced
  // snapshot. We patch the prototype so it covers every db opened later.
  patchTransactionHook(FDBDatabase);

  if (existsSync(path)) {
    try {
      const snap = deserialize(readFileSync(path)) as Snapshot;
      await restoreSnapshot(factory, FDBKeyRange, snap);
      log.info("matrix: restored crypto store from snapshot", {
        path,
        dbs: snap.dbs.length,
      });
    } catch (e) {
      // A corrupt snapshot must not brick startup — fall back to an empty
      // store (the bot re-registers; recovery key restores history).
      log.warn("matrix: crypto snapshot restore failed, starting fresh", {
        path,
        error: (e as Error).message,
      });
    }
  }
}

/**
 * Patch FDBDatabase.transaction so a completing "readwrite" / "versionchange"
 * transaction schedules a debounced snapshot. Only patched once.
 */
function patchTransactionHook(FDBDatabase: {
  prototype: { transaction: (...a: unknown[]) => unknown };
}): void {
  const proto = FDBDatabase.prototype as {
    transaction: (...a: unknown[]) => unknown;
    __phantomPatched?: boolean;
  };
  if (proto.__phantomPatched) return;
  const orig = proto.transaction;
  proto.transaction = function patched(this: unknown, ...args: unknown[]) {
    const tx = orig.apply(this, args) as {
      mode?: string;
      addEventListener?: (ev: string, cb: () => void) => void;
    };
    const mode = args[1] as string | undefined;
    if ((mode === "readwrite" || mode === "versionchange") && tx?.addEventListener) {
      tx.addEventListener("complete", () => scheduleSnapshot());
    }
    return tx;
  };
  proto.__phantomPatched = true;
}

/** Debounced disk write. Coalesces bursts; never overlaps two writes. */
function scheduleSnapshot(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    void runSnapshot();
  }, SNAPSHOT_DEBOUNCE_MS);
}

async function runSnapshot(): Promise<void> {
  if (!snapshotPath) return;
  if (snapshotInFlight) {
    // A write is mid-flight; remember to run again once it lands.
    snapshotQueued = true;
    return;
  }
  snapshotInFlight = true;
  try {
    const snap = await dumpSnapshot();
    const dir = dirname(snapshotPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${snapshotPath}.tmp`;
    writeFileSync(tmp, serialize(snap), { mode: 0o600 });
    renameSync(tmp, snapshotPath); // atomic replace
  } catch (e) {
    log.warn("matrix: crypto snapshot write failed", {
      error: (e as Error).message,
    });
  } finally {
    snapshotInFlight = false;
    if (snapshotQueued) {
      snapshotQueued = false;
      scheduleSnapshot();
    }
  }
}

/** Force a final synchronous-ish snapshot (used on graceful shutdown). */
export async function flushSnapshot(): Promise<void> {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  await runSnapshot();
}

// IDB handles are typed `any`: this project compiles without the DOM lib, and
// the values come from the fake-indexeddb polyfill anyway. The structural
// shape we use (open/transaction/objectStore/getAll…) is exercised at runtime.
/* eslint-disable @typescript-eslint/no-explicit-any */
const idb = (): any => (globalThis as any).indexedDB;

function reqToPromise<T>(req: any): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb request failed"));
  });
}

/** Walk every database via the public API and capture schema + records. */
async function dumpSnapshot(): Promise<Snapshot> {
  const dbs: DbDump[] = [];
  const list = (await idb().databases()) as { name: string; version: number }[];
  for (const { name, version } of list) {
    if (!name) continue;
    const db = await reqToPromise<any>(idb().open(name, version));
    try {
      const storeNames = Array.from(db.objectStoreNames) as string[];
      if (storeNames.length === 0) {
        dbs.push({ name, version: db.version, stores: [] });
        continue;
      }
      const tx = db.transaction(storeNames, "readonly");
      const stores: StoreDump[] = [];
      for (const storeName of storeNames) {
        const os = tx.objectStore(storeName);
        const indexes = (Array.from(os.indexNames) as string[]).map((iname) => {
          const ix = os.index(iname);
          return {
            name: iname,
            keyPath: ix.keyPath as string | string[],
            unique: ix.unique,
            multiEntry: ix.multiEntry,
          };
        });
        const keys = (await reqToPromise(os.getAllKeys())) as unknown[];
        const values = (await reqToPromise(os.getAll())) as unknown[];
        stores.push({
          name: storeName,
          keyPath: os.keyPath as string | string[] | null,
          autoIncrement: os.autoIncrement,
          indexes,
          keys,
          values,
        });
      }
      dbs.push({ name, version: db.version, stores });
    } finally {
      db.close();
    }
  }
  return { version: 1, dbs };
}

/** Recreate every database from a snapshot (schema via upgrade, then records). */
async function restoreSnapshot(
  factory: any,
  _keyRange: unknown,
  snap: Snapshot,
): Promise<void> {
  for (const dbDump of snap.dbs) {
    await new Promise<void>((resolve, reject) => {
      const openReq = factory.open(dbDump.name, dbDump.version || 1);
      openReq.onupgradeneeded = () => {
        const db = openReq.result;
        for (const store of dbDump.stores) {
          const os = db.createObjectStore(store.name, {
            keyPath: store.keyPath as string | string[] | undefined,
            autoIncrement: store.autoIncrement,
          });
          for (const ix of store.indexes) {
            os.createIndex(ix.name, ix.keyPath, {
              unique: ix.unique,
              multiEntry: ix.multiEntry,
            });
          }
        }
      };
      openReq.onerror = () =>
        reject(openReq.error ?? new Error("restore open failed"));
      openReq.onsuccess = () => {
        const db = openReq.result;
        const storesWithData = dbDump.stores.filter((s) => s.keys.length > 0);
        if (storesWithData.length === 0) {
          db.close();
          resolve();
          return;
        }
        const tx = db.transaction(
          storesWithData.map((s) => s.name),
          "readwrite",
        );
        for (const store of storesWithData) {
          const os = tx.objectStore(store.name);
          const inlineKey = store.keyPath !== null;
          for (let i = 0; i < store.values.length; i++) {
            // Inline-key stores derive the key from the value; out-of-line
            // stores need the key passed explicitly.
            if (inlineKey) os.put(store.values[i]);
            else os.put(store.values[i], store.keys[i]);
          }
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("restore write failed"));
        };
      };
    });
  }
}
