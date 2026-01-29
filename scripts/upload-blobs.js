import { uploadDir } from "./gcs.js";

const bucket = process.env.BUCKET;
const runId = process.env.RUN_ID;
const shard = process.env.CLOUD_RUN_TASK_INDEX || 0;

await uploadDir(
  "./blob-report",
  bucket,
  `runs/${runId}/blob/shard-${Number(shard) + 1}`,
);
