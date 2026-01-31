import { cloneRepo } from "./git.js";
import { runTests } from "./playwright.js";
import { uploadShardReports } from "./upload.js";

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

  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0); // 0-based
  const shardCount = Number(process.env.CLOUD_RUN_TASK_COUNT || 1);
  const shardIndex1Based = taskIndex + 1;

  console.log(
    `🧩 Shard: ${shardIndex1Based}/${shardCount} (taskIndex=${taskIndex})`,
  );

  await cloneRepo(TEST_REPO_URL, TEST_REPO_REF);

  const reportDir = `/tmp/blob/${JOB_ID}/shards/${taskIndex}`;
  await runTests(reportDir, shardIndex1Based, shardCount);

  await uploadShardReports(reportDir, REPORT_BUCKET, JOB_ID, taskIndex);

  console.log("✅ Worker done");
}

main().catch((err) => {
  console.error("❌ Worker failed", err);
  process.exit(1);
});
