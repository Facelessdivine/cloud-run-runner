import { cloneRepo } from "./git.js";
import { discoverTests } from "./manifest.js";
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

  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0);
  const totalTasks = Number(process.env.CLOUD_RUN_TASK_COUNT || 1);

  await cloneRepo(TEST_REPO_URL, TEST_REPO_REF);

  const tests = await discoverTests();
  console.log(`📄 Discovered ${tests.length} tests`);

  const shard = sliceShard(tests, taskIndex, totalTasks);
  if (!shard.length) {
    console.log("🟡 No tests assigned — exiting");
    process.exit(0);
  }

  console.log(`🧪 Running ${shard.length} tests`);

  const reportDir = `/tmp/blob/${JOB_ID}/shards/${taskIndex}`;
  await runTests(shard, reportDir);

  await uploadShardReports(reportDir, REPORT_BUCKET, JOB_ID, taskIndex);

  console.log("✅ Worker done");
}

main().catch((err) => {
  console.error("❌ Worker failed", err);
  process.exit(1);
});
function sliceShard(tests, taskIndex, totalTasks) {
  const shardSize = Math.ceil(tests.length / totalTasks);
  const start = taskIndex * shardSize;
  const end = Math.min(start + shardSize, tests.length);
  return tests.slice(start, end);
}
