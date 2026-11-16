let connection;
function open() {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('trainsworld-navigator', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('saves', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function execute(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('saves', mode);
    const request = action(transaction.objectStore('saves'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}
export const listSaves = () => execute('readonly', store => store.getAll());
export const putSave = save => execute('readwrite', store => store.put(save));
export const deleteSave = id => execute('readwrite', store => store.delete(id));
