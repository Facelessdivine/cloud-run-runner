// src/index.js
import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runTests } from "./playwright.js";
import { uploadShardBlob } from "./upload.js";
import { ensureWorkspace } from "./workspace.js";

const storage = new Storage();
const { TEST_REPO_URL, TEST_REPO_REF = "main" } = process.env;
const REPORTS_BUCKET = process.env.REPORTS_BUCKET || process.env.REPORTS_BUCKET;
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET || REPORTS_BUCKET;


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

function getExecutionId() {
  return (
    process.env.CLOUD_RUN_EXECUTION ||
    process.env.CLOUD_RUN_EXECUTION_ID ||
    process.env.EXECUTION_ID ||
    process.env.CLOUD_RUN_EXECUTION_NAME ||
    null
  );
}

async function getOrCreateRunIdViaGcs(bucketName, baseId, shardCount) {
  const bucket = storage.bucket(bucketName);

  // Marker lives under a stable prefix so ALL tasks can discover it.
  const markerObject = `${baseId}/_runid.txt`;
  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0);

  if (taskIndex === 0) {
    const runId = `${baseId}-${runStampUtc()}-${shortRand()}`;
    const body = `${runId}\nshards=${shardCount}\ncreated=${new Date().toISOString()}\n`;
    console.log(`📝 Writing RUN_ID marker: gs://${bucketName}/${markerObject}`);
    await bucket.file(markerObject).save(body, {
      resumable: false,
      contentType: "text/plain",
      metadata: { cacheControl: "no-store" },
    });
    return runId;
  }

  console.log(`⏳ Waiting RUN_ID marker: gs://${bucketName}/${markerObject}`);
  const start = Date.now();
  const timeoutMs = 2 * 60 * 1000;

  while (true) {
    try {
      const file = bucket.file(markerObject);
      const [exists] = await file.exists();
      if (exists) {
        const [buf] = await file.download();
        const txt = buf.toString("utf-8").trim();
        const runId = txt.split("\n")[0];
        if (runId) return runId;
      }
    } catch {
      // transient, retry
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for RUN_ID marker gs://${bucketName}/${markerObject}`,
      );
    }
    await sleep(2000);
  }
}

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

    // You upload: <runId>/blobs/shard-<n>.zip
    const shardZips = files
      .map((f) => f.name)
      .filter((name) => /\/blobs\/shard-\d+\.zip$/.test(name));

    console.log(
      `⏳ Waiting blobs: ${shardZips.length}/${expectedCount} present under gs://${bucketName}/${prefix}`,
    );

    if (shardZips.length >= expectedCount) return shardZips.sort();

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for blobs. Found ${shardZips.length}/${expectedCount} under gs://${bucketName}/${prefix}. Found: ${shardZips.sort().join(", ")}`,
      );
    }

    await sleep(5000);
  }
}

async function main() {
  console.log("🚀 Worker starting");

  process.env.RUN_STARTED_AT = process.env.RUN_STARTED_AT || new Date().toISOString();

  if (!TEST_REPO_URL) throw new Error("TEST_REPO_URL missing");
  if (!REPORTS_BUCKET) throw new Error("REPORTS_BUCKET (or REPORTS_BUCKET) missing");

  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0);
  const shardCount = Number(process.env.CLOUD_RUN_TASK_COUNT || 1);
  const shardIndex1Based = taskIndex + 1;

  const baseIdRaw = repoNameFromUrl(TEST_REPO_URL);
  const baseId = String(baseIdRaw).replace(/[^a-zA-Z0-9._-]+/g, "-");

  const executionId = getExecutionId();
  const RUN_ID = executionId
    ? `${baseId}-${executionId}`
    : await getOrCreateRunIdViaGcs(REPORTS_BUCKET, baseId, shardCount);

  process.env.RUN_ID = RUN_ID;

  console.log(
    `🧩 Shard: ${shardIndex1Based}/${shardCount} (taskIndex=${taskIndex})`,
  );

  const repoDir = await ensureWorkspace({
    repoUrl: TEST_REPO_URL,
    repoRef: TEST_REPO_REF,
    bucketName: WORKSPACE_BUCKET,
    runId: RUN_ID,
  });

  const reportDir = path.join(
    os.tmpdir(),
    "blob",
    RUN_ID,
    "shards",
    String(taskIndex),
  );

  const { blob, exitCode } = await runTests(
    reportDir,
    shardIndex1Based,
    shardCount,
    taskIndex,
    repoDir,
  );

  await uploadShardBlob(blob, REPORTS_BUCKET, RUN_ID, taskIndex);

  if (exitCode !== 0) {
    console.error(
      `⚠️ Shard ${taskIndex} had test failures (exitCode=${exitCode}). Upload succeeded; continuing.`,
    );
  }
  console.log(`✅ Shard ${shardIndex1Based}/${shardCount} upload completed`);

  if (taskIndex === 0) {
    console.log(
      "👑 Coordinator: waiting for all shard blobs before merging...",
    );

    const found = await waitForAllBlobs(REPORTS_BUCKET, RUN_ID, shardCount);
    console.log(`✅ All blobs present (${found.length}). Example: ${found[0]}`);

    console.log("🧩 All blobs present. Running merge.js");
    execSync("node /app/src/merge.js", {
      stdio: "inherit",
      env: { ...process.env, RUN_ID: RUN_ID, REPORTS_BUCKET },
    });
  }

  console.log("✅ Worker done");
}

main().catch((err) => {
  console.error("❌ Worker failed", err);
  process.exit(1);
});
