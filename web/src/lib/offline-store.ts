export interface OfflineStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

const STORE_NAME = "offline";

/** False in private browsing modes and older browsers where indexedDB is absent. */
export function isOfflineStoreAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolvePromise(request.result);
    request.onerror = () => rejectPromise(request.error);
  });
}

function run<T>(databaseName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase(databaseName).then(
    (database) =>
      new Promise<T>((resolvePromise, rejectPromise) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolvePromise(request.result);
        request.onerror = () => rejectPromise(request.error);
        transaction.oncomplete = () => database.close();
      }),
  );
}

/**
 * IndexedDB-backed store. Values are written by structured clone, which handles
 * the plain objects @bufbuild/protobuf's create() produces, so no JSON
 * round-trip is needed.
 */
export function createIndexedDbStore(databaseName: string): OfflineStore {
  return {
    get: <T>(key: string) =>
      run<T | undefined>(databaseName, "readonly", (store) => store.get(key) as IDBRequest<T | undefined>).catch(() => undefined),
    set: (key, value) => run(databaseName, "readwrite", (store) => store.put(value, key)).then(() => undefined),
    remove: (key) => run(databaseName, "readwrite", (store) => store.delete(key)).then(() => undefined),
    keys: () => run(databaseName, "readonly", (store) => store.getAllKeys()).then((keys) => keys.map(String)),
    clear: () => run(databaseName, "readwrite", (store) => store.clear()).then(() => undefined),
  };
}

/** In-memory implementation for tests; jsdom has no IndexedDB. */
export function createMemoryStore(): OfflineStore {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    keys: async () => [...values.keys()],
    clear: async () => void values.clear(),
  };
}

export interface OfflineStorageUsage {
  usage: number;
  quota: number;
  persisted: boolean;
}

/**
 * Storage held for this origin, or undefined when the API is absent. With no cap
 * on memo count, eviction would otherwise be invisible — this is where the user
 * finds out the cache is large or that persistence was refused.
 */
export async function readOfflineStorageUsage(): Promise<OfflineStorageUsage | undefined> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return undefined;
  try {
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
    ]);
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted };
  } catch {
    return undefined;
  }
}
