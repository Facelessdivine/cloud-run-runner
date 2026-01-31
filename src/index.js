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

async function main() {
  console.log("🚀 Worker starting");

  if (!TEST_REPO_URL) throw new Error("TEST_REPO_URL missing");
  if (!REPORT_BUCKET) throw new Error("REPORT_BUCKET missing");

  // ✅ RUN_ID is unique by default; can still be overridden by env JOB_ID
  const JOB_ID =
    process.env.JOB_ID ||
    `${repoNameFromUrl(TEST_REPO_URL)}-${runStampUtc()}-${shortRand()}`;
  const RUN_ID =
    JOB_ID ||
    `${repoNameFromUrl(TEST_REPO_URL)}-${runStampUtc()}-${shortRand()}`;

  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0); // 0-based
  const shardCount = Number(process.env.CLOUD_RUN_TASK_COUNT || 1);
  const shardIndex1Based = taskIndex + 1;

  console.log(
    `🧩 Shard: ${shardIndex1Based}/${shardCount} (taskIndex=${taskIndex})`,
  );
  console.log(`🆔 RUN_ID=${RUN_ID}`);
  console.log(`🪣 REPORT_BUCKET=${REPORT_BUCKET}`);
  console.log(`🌿 TEST_REPO_REF=${TEST_REPO_REF}`);

  await cloneRepo(TEST_REPO_URL, TEST_REPO_REF);

  const reportDir = `/tmp/blob/${RUN_ID}/shards/${taskIndex}`;
  const blobZip = await runTests(
    reportDir,
    shardIndex1Based,
    shardCount,
    taskIndex,
  );
  await uploadShardBlob(blobZip, REPORT_BUCKET, JOB_ID);

  console.log(`✅ Shard ${shardIndex1Based}/${shardCount} upload completed`);

  if (taskIndex === 0) {
    console.log("👑 Coordinator: will run merge.js (retry until success)");

    await retryUntilSuccess(
      () => {
        execSync("node /app/src/merge.js", {
          stdio: "inherit",
          env: { ...process.env, JOB_ID: RUN_ID, REPORT_BUCKET },
        });
      },
      { timeoutMs: 30 * 60 * 1000, intervalMs: 10 * 1000 },
    );

    const indexObject = `${RUN_ID}/final/html/index.html`;
    console.log("====================================================");
    console.log("✅ MERGE COMPLETED");
    console.log(`📍 HTML: gs://${REPORT_BUCKET}/${indexObject}`);
    console.log("====================================================");

    console.log("🧹 Cleanup: deleting shard blobs...");
    await deletePrefix(REPORT_BUCKET, `${RUN_ID}/shards/`);
    console.log("✅ Cleanup done");
  } else {
    console.log(`ℹ️ Non-coordinator shard done (taskIndex=${taskIndex})`);
  }

  console.log("✅ Worker done");
}

async function retryUntilSuccess(fn, { timeoutMs, intervalMs }) {
  const started = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      console.log(`🔁 Merge attempt #${attempt}`);
      fn();
      return;
    } catch (err) {
      const elapsed = Date.now() - started;

      console.log(
        "⏳ merge.js not ready yet (likely missing shard blobs). Retrying...",
      );
      console.log(
        `   elapsed=${Math.round(elapsed / 1000)}s, next retry in ${Math.round(intervalMs / 1000)}s`,
      );

      if (elapsed > timeoutMs) {
        console.error("❌ Timeout waiting for merge to succeed");
        throw err;
      }

      await sleep(intervalMs);
    }
  }
}

async function deletePrefix(bucketName, prefix) {
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix });

  const deletions = files.filter((f) => !f.name.endsWith("/"));
  if (!deletions.length) {
    console.log(`ℹ️ Nothing to delete under gs://${bucketName}/${prefix}`);
    return;
  }

  const batchSize = 200;
  for (let i = 0; i < deletions.length; i += batchSize) {
    const batch = deletions.slice(i, i + batchSize);
    await Promise.allSettled(batch.map((f) => f.delete()));
    console.log(
      `🗑️ Deleted ${Math.min(i + batchSize, deletions.length)}/${deletions.length}`,
    );
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("❌ Worker failed", err);
  process.exit(1);
});
