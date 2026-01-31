// src/upload.js
import { Storage } from "@google-cloud/storage";
import fs from "node:fs";
import path from "node:path";

const storage = new Storage();

export async function uploadShardReports(localDir, bucketName, jobId, shardId) {
  console.log(`📤 Uploading shard ${shardId}`);

  const bucket = storage.bucket(bucketName);

  const prefix = `${jobId}/shards/${shardId}`;

  if (localDir && fs.existsSync(localDir)) {
    await walkAndUpload(localDir, localDir, bucket, prefix);
  } else {
    console.log(`🟡 localDir not found: ${localDir} (shard ${shardId})`);
  }

  const blobDir = path.resolve("blob-report");
  if (!fs.existsSync(blobDir)) {
    console.log(
      `🟡 blob-report folder not found at ${blobDir} (shard ${shardId})`,
    );
    return;
  }

  const blobZips = fs
    .readdirSync(blobDir)
    .filter((f) => f.startsWith("report-") && f.endsWith(".zip"));

  if (!blobZips.length) {
    console.log(`🟡 No report-*.zip found in blob-report (shard ${shardId})`);
    console.log(
      "   This can be normal if this shard had 0 tests. Otherwise, check runTests() uses --reporter=blob.",
    );
    return;
  }

  console.log(
    `📦 Uploading ${blobZips.length} blob zip(s) for shard ${shardId}`,
  );

  for (const zip of blobZips) {
    const full = path.join(blobDir, zip);

    const dest = `${prefix}/blob/${zip}`;
    await bucket.upload(full, { destination: dest });
    console.log(`Uploaded: ${dest}`);
  }
}

async function walkAndUpload(rootDir, baseDir, bucket, prefix) {
  for (const entry of fs.readdirSync(rootDir)) {
    const full = path.join(rootDir, entry);
    const rel = path.relative(baseDir, full).replaceAll("\\", "/");

    if (fs.statSync(full).isDirectory()) {
      await walkAndUpload(full, baseDir, bucket, prefix);
    } else {
      await bucket.upload(full, { destination: `${prefix}/${rel}` });
    }
  }
}
