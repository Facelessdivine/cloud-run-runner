// src/upload.js
import { Storage } from "@google-cloud/storage";
import fs from "node:fs";
import path from "node:path";

const storage = new Storage();

function isDir(p) {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}
function isFile(p) {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

/**
 * Uploads either:
 * - a blob zip file
 * - OR a blob-report directory (uploads all files recursively)
 *
 * Destination layout:
 * - zip:   gs://bucket/<runId>/blobs/shard-<taskIndex>.zip
 * - dir:   gs://bucket/<runId>/blobs/shard-<taskIndex>/<...files>
 */
export async function uploadShardBlob(blobPath, bucketName, runId, taskIndex) {
  const bucket = storage.bucket(bucketName);

  // CASE 1: zip/file
  if (isFile(blobPath)) {
    const dest = `${runId}/blobs/shard-${taskIndex}.zip`;
    console.log(
      `📤 Uploading blob file ${path.basename(blobPath)} → gs://${bucketName}/${dest}`,
    );
    await bucket.upload(blobPath, { destination: dest });
    return;
  }

  // CASE 2: directory
  if (isDir(blobPath)) {
    const baseDest = `${runId}/blobs/shard-${taskIndex}`;
    console.log(
      `📤 Uploading blob dir ${path.basename(blobPath)} → gs://${bucketName}/${baseDest}/`,
    );

    const uploadRecursive = async (dir, prefix) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const local = path.join(dir, ent.name);
        const dest = `${prefix}/${ent.name}`;

        if (ent.isDirectory()) {
          await uploadRecursive(local, dest);
        } else if (ent.isFile()) {
          await bucket.upload(local, { destination: dest });
        }
      }
    };

    await uploadRecursive(blobPath, baseDest);
    return;
  }

  throw new Error(
    `uploadShardBlob: path does not exist or is not file/dir: ${blobPath}`,
  );
}


/**
 * Upload per-shard JUnit XML.
 * Destination:
 *   gs://bucket/<runId>/junit/shard-<taskIndex>.xml
 */
export async function uploadShardJUnit(junitPath, bucketName, runId, taskIndex) {
  const bucket = storage.bucket(bucketName);
  if (!isFile(junitPath)) {
    console.warn(`⚠️ uploadShardJUnit: junit file not found: ${junitPath} (continuing)`);
    return;
  }
  const dest = `${runId}/junit/shard-${taskIndex}.xml`;
  console.log(`📤 Uploading junit ${path.basename(junitPath)} → gs://${bucketName}/${dest}`);
  await bucket.upload(junitPath, { destination: dest });
}
