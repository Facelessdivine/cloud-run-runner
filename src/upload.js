import { Storage } from "@google-cloud/storage";
import fs from "node:fs";
import path from "node:path";

const storage = new Storage();

export async function uploadShardReports(localDir, bucketName, jobId, shardId) {
  console.log(`📤 Uploading shard ${shardId}`);

  const bucket = storage.bucket(bucketName);
  const prefix = `${jobId}/shards/${shardId}`;

  async function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = path.relative(localDir, full);

      if (fs.statSync(full).isDirectory()) await walk(full);
      else {
        await bucket.upload(full, { destination: `${prefix}/${rel}` });
      }
    }
  }

  await walk(localDir);
}
