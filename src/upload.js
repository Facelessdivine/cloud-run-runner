// src/upload.js
import { Storage } from "@google-cloud/storage";
import fs from "node:fs";
import path from "node:path";

const storage = new Storage();

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export async function uploadShardReports(localDir, bucketName, jobId, shardId) {
  const bucket = storage.bucket(bucketName);

  // 1) Upload ALL shard artifacts from localDir
  // (traces, screenshots, attachments, etc.)
  if (localDir && fs.existsSync(localDir)) {
    console.log(`📤 Uploading ALL artifacts for shard ${shardId}...`);
    const files = walk(localDir);
    for (const full of files) {
      const rel = path.relative(localDir, full).replaceAll("\\", "/");
      const dest = `${jobId}/shards/${shardId}/artifacts/${rel}`;
      await bucket.upload(full, { destination: dest });
    }
  } else {
    console.log(
      `🟡 No local artifacts dir found at ${localDir} (shard ${shardId})`,
    );
  }

  // 2) Upload blob reporter zips (merge input)
  // Playwright blob reporter writes to ./blob-report by default
  const blobDir = path.resolve("blob-report");
  if (!fs.existsSync(blobDir)) {
    console.log(`🟡 No blob-report folder found for shard ${shardId}`);
    return;
  }

  const blobZips = fs
    .readdirSync(blobDir)
    .filter((f) => f.startsWith("report-") && f.endsWith(".zip"));

  if (!blobZips.length) {
    console.log(
      `🟡 blob-report has no report-*.zip files for shard ${shardId}`,
    );
    return;
  }

  console.log(`📤 Uploading blob zips for shard ${shardId}...`);
  for (const zip of blobZips) {
    const full = path.join(blobDir, zip);
    const dest = `${jobId}/shards/${shardId}/blob/${zip}`;
    await bucket.upload(full, { destination: dest });
    console.log(`Uploaded: ${dest}`);
  }
}
