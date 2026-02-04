import { Storage } from "@google-cloud/storage";

const storage = new Storage();

async function deletePrefix(bucketName, prefix) {
  if (!bucketName || !prefix) return;
  const bucket = storage.bucket(bucketName);
  let pageToken = undefined;
  while (true) {
    const [files, , resp] = await bucket.getFiles({ prefix, pageToken });
    if (!files.length) break;
    await Promise.allSettled(files.map((f) => f.delete()));
    pageToken = resp?.nextPageToken;
    if (!pageToken) break;
  }
}

export async function cleanupBlobs(bucketName, prefix) {
  await deletePrefix(bucketName, prefix);
}

// Backwards/for merge usage
export async function cleanupRun(blobsBucket, blobsPrefix, workspaceBucket, workspacePrefix) {
  await deletePrefix(blobsBucket, blobsPrefix);
  await deletePrefix(workspaceBucket, workspacePrefix);
}
