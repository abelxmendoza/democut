// Take persistence: blobs + metadata in IndexedDB, so a project's takes
// survive page reloads and browser restarts on this machine.
// Honest limits: browser storage can be evicted under disk pressure and
// doesn't exist in private windows — downloading keepers is still wise.
// If IndexedDB is unavailable, every call quietly no-ops / returns empty
// and the app falls back to session-only takes.

export interface StoredTake {
  id: string
  projectId: string
  name: string
  duration: number
  size: number
  createdAt: string // ISO
  blob: Blob
  markers?: { t: number; label: string }[]
  captions?: { start: number; end: number; text: string }[]
}

const DB_NAME = 'democut'
const STORE = 'takes'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction(STORE, mode)
          const req = run(t.objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
          t.oncomplete = () => db.close()
          t.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export async function loadTakes(): Promise<StoredTake[]> {
  const all = await tx<StoredTake[]>('readonly', (s) => s.getAll() as IDBRequest<StoredTake[]>)
  return all ?? []
}

export async function saveTake(t: StoredTake): Promise<void> {
  await tx('readwrite', (s) => s.put(t))
}

export async function deleteTake(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}

export async function deleteTakesForProject(projectId: string): Promise<void> {
  const all = await loadTakes()
  for (const t of all) if (t.projectId === projectId) await deleteTake(t.id)
}
