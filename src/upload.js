import { Storage } from "@google-cloud/storage";
import path from "node:path";

const storage = new Storage();

export async function uploadShardBlob(blobZipPath, bucketName, jobId) {
  const bucket = storage.bucket(bucketName);

  const fileName = path.basename(blobZipPath);
  const destination = `${jobId}/blobs/${fileName}`;

  console.log(
    `📤 Uploading blob ${fileName} → gs://${bucketName}/${destination}`,
  );

  await bucket.upload(blobZipPath, { destination });
}
