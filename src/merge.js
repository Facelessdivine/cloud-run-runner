import { cleanupBlobs } from "./cleanup.js";
import { downloadDir, uploadDir } from "./gcs.js";
import { mergePlaywrightReports } from "./mergePlaywright.js";

const { JOB_ID, REPORT_BUCKET } = process.env;

async function main() {
  if (!JOB_ID) throw new Error("JOB_ID missing");
  if (!REPORT_BUCKET) throw new Error("REPORT_BUCKET missing");

  console.log("🧩 Merging reports");

  const workDir = `/tmp/${JOB_ID}`;
  const shardsPrefix = `${JOB_ID}/shards`;

  await downloadDir(REPORT_BUCKET, shardsPrefix, workDir);

  const { htmlDir, junitFile } = mergePlaywrightReports({
    allBlobDir: workDir,
    mergedDir: workDir,
  });

  await uploadDir(REPORT_BUCKET, htmlDir, `${JOB_ID}/final/html`);
  await uploadDir(REPORT_BUCKET, junitFile, `${JOB_ID}/final/junit.xml`);

  await cleanupBlobs(REPORT_BUCKET, shardsPrefix);

  console.log("✅ Merge + cleanup done");
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
