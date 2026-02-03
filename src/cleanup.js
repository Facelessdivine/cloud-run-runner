import { Storage } from "@google-cloud/storage";

const storage = new Storage();

export async function cleanupBlobs(bucketName, prefix) {
  console.log(`🧹 Cleaning gs://${bucketName}/${prefix}`);

  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix });

  await Promise.all(files.map((f) => f.delete()));
}
