/**
 * Salvataggio locale della canzone caricata dall'utente.
 * Il file resta nel browser (IndexedDB): il sito non lo invia da nessuna parte
 * e non scarica nulla da solo.
 */
const DB_NAME = 'dod3-final-song';
const STORE = 'audio';
const KEY = 'song';

interface StoredAudio {
  name: string;
  type: string;
  blob: Blob;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAudioFile(file: File): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(
        { name: file.name, type: file.type, blob: file, savedAt: Date.now() } satisfies StoredAudio,
        KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAudioFile(): Promise<File | null> {
  try {
    const db = await openDb();
    const record = await new Promise<StoredAudio | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result as StoredAudio | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (!record?.blob) return null;
    return new File([record.blob], record.name || 'song.mp3', { type: record.type || 'audio/mpeg' });
  } catch {
    return null;
  }
}

export async function clearAudioFile(): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // storage non disponibile
  }
}
