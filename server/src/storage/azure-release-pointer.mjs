export function createAzureBlobReleasePointerStore({ blobClient, container, blobName = 'current/release-pointer.json' } = {}) {
  if (!blobClient || typeof blobClient.getJson !== 'function' || typeof blobClient.putJson !== 'function') {
    throw new TypeError('blobClient with getJson and putJson is required');
  }
  if (typeof container !== 'string' || !container) throw new TypeError('container is required');

  return Object.freeze({
    async read() {
      const current = await blobClient.getJson(container, blobName);
      return current?.value ?? null;
    },
    async commit(pointer) {
      const current = await blobClient.getJson(container, blobName);
      const conditions = current?.etag
        ? { ifMatch: current.etag }
        : { ifNoneMatch: '*' };
      try {
        await blobClient.putJson(container, blobName, pointer, conditions);
      } catch (error) {
        if (error.status === 412 || error.code === 'ConditionNotMet' || error.code === 'BlobAlreadyExists') {
          const conflict = new Error('release pointer changed during publication');
          conflict.code = 'RELEASE_POINTER_CONFLICT';
          throw conflict;
        }
        throw error;
      }
      return pointer;
    },
  });
}
