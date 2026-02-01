// src/index.js
import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
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

/**
 * Cloud Run Jobs should provide an execution identifier shared by all tasks.
 * Names can vary; we check a few common candidates.
 */
function getExecutionId() {
  return (
    process.env.CLOUD_RUN_EXECUTION ||
    process.env.CLOUD_RUN_EXECUTION_ID ||
    process.env.EXECUTION_ID ||
    process.env.CLOUD_RUN_EXECUTION_NAME ||
    null
  );
}

/**
 * If execution id is not available (rare), we coordinate RUN_ID via a small GCS marker file.
 * Task 0 writes it once; other tasks poll until it exists.
 */
async function getOrCreateRunIdViaGcs(bucketName, baseId, shardCount) {
  const bucket = storage.bucket(bucketName);
  const markerObject = `${baseId}/_runid.txt`;

  // Task 0 creates the marker.
  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0);
  if (taskIndex === 0) {
    const runId = `${baseId}-${runStampUtc()}-${shortRand()}`;
    const contents = `${runId}\nshards=${shardCount}\n`;
    await bucket.file(markerObject).save(contents, {
      resumable: false,
      contentType: "text/plain",
      metadata: { cacheControl: "no-store" },
    });
    return runId;
  }

  // Other tasks wait for marker to exist and read it.
  const start = Date.now();
  const timeoutMs = 2 * 60 * 1000;

  while (true) {
    try {
      const [exists] = await bucket.file(markerObject).exists();
      if (exists) {
        const [buf] = await bucket.file(markerObject).download();
        const txt = buf.toString("utf-8").trim();
        const runIdLine = txt.split("\n")[0];
        if (runIdLine) return runIdLine;
      }
    } catch {
      // ignore transient errors, retry
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for RUN_ID marker gs://${bucketName}/${markerObject}`,
      );
    }
    await sleep(2000);
  }
}

/**
 * Wait until all expected shard artifacts are present under <RUN_ID>/blobs/
 * You currently upload to: <RUN_ID>/blobs/shard-<taskIndex>.zip
 */
async function waitForAllBlobs(
  bucketName,
  runId,
  expectedCount,
  timeoutMs = 20 * 60 * 1000,
) {
  const bucket = storage.bucket(bucketName);
  const prefix = `${runId}/blobs/`;
  const start = Date.now();

  while (true) {
    const [files] = await bucket.getFiles({ prefix });

    // Count shard-*.zip files directly under blobs/
    const shardZips = files.filter((f) =>
      /\/blobs\/shard-\d+\.zip$/.test(f.name),
    );

    console.log(
      `⏳ Waiting blobs: ${shardZips.length}/${expectedCount} present under gs://${bucketName}/${prefix}`,
    );

    if (shardZips.length >= expectedCount) return;

    if (Date.now() - start > timeoutMs) {
      const found = shardZips
        .map((f) => f.name)
        .sort()
        .join(", ");
      throw new Error(
        `Timed out waiting for blobs. Found ${shardZips.length}/${expectedCount} under gs://${bucketName}/${prefix}. Found: ${found}`,
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

  const baseIdRaw = process.env.JOB_ID || repoNameFromUrl(TEST_REPO_URL);
  const baseId = String(baseIdRaw).replace(/[^a-zA-Z0-9._-]+/g, "-");

  const executionId = getExecutionId();

  // ✅ Shared RUN_ID generated inside job:
  // Prefer executionId (shared by all tasks). Fallback to GCS coordination.
  const RUN_ID = executionId
    ? `${baseId}-${executionId}`
    : await getOrCreateRunIdViaGcs(REPORT_BUCKET, baseId, shardCount);

  console.log(
    `🧩 Shard: ${shardIndex1Based}/${shardCount} (taskIndex=${taskIndex})`,
  );
  console.log(`🆔 RUN_ID=${RUN_ID}`);
  console.log(`🪣 REPORT_BUCKET=${REPORT_BUCKET}`);
  console.log(`🌿 TEST_REPO_REF=${TEST_REPO_REF}`);
  console.log("🧠 Task identity:", {
    CLOUD_RUN_TASK_INDEX: process.env.CLOUD_RUN_TASK_INDEX,
    CLOUD_RUN_TASK_COUNT: process.env.CLOUD_RUN_TASK_COUNT,
    HOSTNAME: process.env.HOSTNAME,
    EXECUTION_ID: executionId,
  });

  const repoDir = await cloneRepo(TEST_REPO_URL, TEST_REPO_REF);

  const reportDir = path.join(
    os.tmpdir(),
    "blob",
    RUN_ID,
    "shards",
    String(taskIndex),
  );

  const blobArtifact = await runTests(
    reportDir,
    shardIndex1Based,
    shardCount,
    taskIndex,
    repoDir,
  );

  await uploadShardBlob(blobArtifact, REPORT_BUCKET, RUN_ID, taskIndex);

  console.log(`✅ Shard ${shardIndex1Based}/${shardCount} upload completed`);

  if (taskIndex === 0) {
    console.log(
      "👑 Coordinator: waiting for all shard blobs before merging...",
    );

    await waitForAllBlobs(REPORT_BUCKET, RUN_ID, shardCount);

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
