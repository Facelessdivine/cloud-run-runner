import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";

import { cloneRepo } from "./git.js";
import { runTests } from "./playwright.js";
import { uploadShardReports } from "./upload.js";

const storage = new Storage();

const {
  TEST_REPO_URL,
  TEST_REPO_REF = "main",
  JOB_ID,
  REPORT_BUCKET,
} = process.env;

async function main() {
  console.log("🚀 Worker starting");

  if (!TEST_REPO_URL) throw new Error("TEST_REPO_URL missing");
  if (!JOB_ID) throw new Error("JOB_ID missing");
  if (!REPORT_BUCKET) throw new Error("REPORT_BUCKET missing");

  // Cloud Run Jobs (0-based index, total count)
  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0);
  const shardCount = Number(process.env.CLOUD_RUN_TASK_COUNT || 1);
  const shardIndex1Based = taskIndex + 1;

  console.log(
    `🧩 Shard: ${shardIndex1Based}/${shardCount} (taskIndex=${taskIndex})`,
  );
  console.log(`🆔 JOB_ID=${JOB_ID}`);
  console.log(`🪣 REPORT_BUCKET=${REPORT_BUCKET}`);

  // 1) Clone the test repo
  await cloneRepo(TEST_REPO_URL, TEST_REPO_REF);

  // 2) Run this shard (Playwright native sharding splits test cases correctly)
  const reportDir = `/tmp/blob/${JOB_ID}/shards/${taskIndex}`;
  await runTests(reportDir, shardIndex1Based, shardCount);

  // 3) Upload shard artifacts to GCS
  await uploadShardReports(reportDir, REPORT_BUCKET, JOB_ID, taskIndex);

  console.log(`✅ Shard ${shardIndex1Based}/${shardCount} uploaded`);

  // 4) Coordinator: wait for all shards, then run merge.js
  if (taskIndex === 0) {
    console.log(
      `👑 Coordinator task detected (taskIndex=0). Waiting for ${shardCount} shards...`,
    );

    // Wait until all shard folders appear in GCS under JOB_ID/shards/
    await waitForAllShards({
      bucketName: REPORT_BUCKET,
      jobId: JOB_ID,
      expectedShards: shardCount,
      timeoutMs: 30 * 60 * 1000, // 30 minutes
      pollEveryMs: 10 * 1000, // 10 seconds
    });

    console.log("🧩 All shards found. Executing merge.js...");

    // IMPORTANT: merge.js must use JOB_ID + REPORT_BUCKET to download/merge/upload finals.
    // We run it in the same container.
    execSync("node src/merge.js", {
      stdio: "inherit",
      env: {
        ...process.env,
        JOB_ID,
        REPORT_BUCKET,
      },
    });

    console.log("🏁 Coordinator finished merge.js");
  } else {
    console.log(`ℹ️ Non-coordinator shard done (taskIndex=${taskIndex}).`);
  }

  console.log("✅ Worker done");
}

/**
 * Checks GCS for shard folders under:
 *   gs://<bucket>/<jobId>/shards/<shardId>/*
 *
 * We detect shardId by parsing file object paths.
 */
async function waitForAllShards({
  bucketName,
  jobId,
  expectedShards,
  timeoutMs,
  pollEveryMs,
}) {
  const bucket = storage.bucket(bucketName);
  const prefix = `${jobId}/shards/`;

  const started = Date.now();
  while (true) {
    const shardIds = await getShardIds(bucket, prefix);

    console.log(
      `🔎 Found ${shardIds.size}/${expectedShards} shard folders: ${[...shardIds].sort().join(", ") || "(none)"}`,
    );

    if (shardIds.size >= expectedShards) return;

    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Timeout waiting for shards. Found ${shardIds.size}/${expectedShards} under gs://${bucketName}/${prefix}`,
      );
    }

    await sleep(pollEveryMs);
  }
}

async function getShardIds(bucket, prefix) {
  // Get a snapshot of objects under the shards prefix
  const [files] = await bucket.getFiles({ prefix });

  const shardIds = new Set();
  for (const f of files) {
    // f.name like: "<jobId>/shards/<shardId>/whatever"
    const rest = f.name.slice(prefix.length); // "<shardId>/whatever"
    const shardId = rest.split("/")[0];
    if (shardId) shardIds.add(shardId);
  }

  return shardIds;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("❌ Worker failed", err);
  process.exit(1);
});
