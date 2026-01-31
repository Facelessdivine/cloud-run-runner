// src/index.js
import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";
import { cloneRepo } from "./git.js";
import { runTests } from "./playwright.js";
import { uploadShardBlob } from "./upload.js";

const storage = new Storage();
const { TEST_REPO_URL, TEST_REPO_REF = "main", REPORT_BUCKET } = process.env;

function repoNameFromUrl(url) {
  const clean = url.replace(/\/+$/, "");
  const last = clean.split("/").pop() || "repo";
  return last.replace(/\.git$/i, "");
}

function runStampUtc() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function shortRand() {
  return Math.random().toString(36).slice(2, 8);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForAllBlobs(
  bucketName,
  prefix,
  expectedCount,
  timeoutMs = 20 * 60 * 1000,
) {
  const bucket = storage.bucket(bucketName);
  const start = Date.now();

  while (true) {
    const [files] = await bucket.getFiles({ prefix });
    const zips = files.filter((f) => f.name.endsWith(".zip"));

    console.log(
      `⏳ Waiting blobs: ${zips.length}/${expectedCount} present under gs://${bucketName}/${prefix}`,
    );

    if (zips.length >= expectedCount) return;

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for blobs. Found ${zips.length}/${expectedCount} under gs://${bucketName}/${prefix}`,
      );
    }
    await sleep(5000);
  }
}

async function main() {
  console.log("🚀 Worker starting");

  if (!TEST_REPO_URL) throw new Error("TEST_REPO_URL missing");
  if (!REPORT_BUCKET) throw new Error("REPORT_BUCKET missing");

  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0); // 0-based
  const shardCount = Number(process.env.CLOUD_RUN_TASK_COUNT || 1);
  const shardIndex1Based = taskIndex + 1;

  // Base can come from JOB_ID or repo name, but RUN_ID is ALWAYS unique.
  const baseId = process.env.JOB_ID || repoNameFromUrl(TEST_REPO_URL);

  // ✅ Cloud Run execution name/id is shared across tasks in same run
  const executionId =
    process.env.CLOUD_RUN_EXECUTION ||
    process.env.CLOUD_RUN_EXECUTION_ID ||
    process.env.EXECUTION_ID;

  const RUN_ID = process.env.RUN_ID
    ? process.env.RUN_ID
    : executionId
      ? `${baseId}-${executionId}`
      : null;

  if (!RUN_ID) {
    throw new Error(
      "RUN_ID could not be determined. Set RUN_ID env var when executing the Cloud Run Job, or ensure the execution id env var is available.",
    );
  }

  console.log(
    `🧩 Shard: ${shardIndex1Based}/${shardCount} (taskIndex=${taskIndex})`,
  );
  console.log(`🆔 RUN_ID=${RUN_ID}`);
  console.log(`🪣 REPORT_BUCKET=${REPORT_BUCKET}`);
  console.log(`🌿 TEST_REPO_REF=${TEST_REPO_REF}`);

  const repoDir = await cloneRepo(TEST_REPO_URL, TEST_REPO_REF);

  const reportDir = `/tmp/blob/${RUN_ID}/shards/${taskIndex}`;
  const blobZip = await runTests(
    reportDir,
    shardIndex1Based,
    shardCount,
    taskIndex,
    repoDir,
  );

  await uploadShardBlob(blobZip, REPORT_BUCKET, RUN_ID);
  console.log(`✅ Shard ${shardIndex1Based}/${shardCount} upload completed`);

  if (taskIndex === 0) {
    console.log(
      "👑 Coordinator: waiting for all shard blobs before merging...",
    );

    const blobsPrefix = `${RUN_ID}/blobs/`;
    await waitForAllBlobs(REPORT_BUCKET, blobsPrefix, shardCount);

    console.log("🧩 All blobs present. Running merge.js");
    execSync("node /app/src/merge.js", {
      stdio: "inherit",
      env: { ...process.env, JOB_ID: RUN_ID, REPORT_BUCKET },
    });

    const indexObject = `${RUN_ID}/final/html/index.html`;
    console.log("====================================================");
    console.log("✅ MERGE COMPLETED");
    console.log(`📍 HTML: gs://${REPORT_BUCKET}/${indexObject}`);
    console.log("====================================================");
  } else {
    console.log(`ℹ️ Non-coordinator shard done (taskIndex=${taskIndex})`);
  }

  console.log("✅ Worker done");
}

main().catch((err) => {
  console.error("❌ Worker failed", err);
  process.exit(1);
});
