import { cleanupBlobs } from "./cleanup.js";
import { downloadDir, uploadDir } from "./gcs.js";
import { mergeReports } from "./mergePlaywright.js";
import { generateSignedUrls } from "./signedUrls.js";

const { JOB_ID, REPORT_BUCKET } = process.env;

async function main() {
  if (!JOB_ID) throw new Error("JOB_ID missing");
  if (!REPORT_BUCKET) throw new Error("REPORT_BUCKET missing");

  console.log("🧩 Merging reports");

  const workDir = `/tmp/${JOB_ID}`;
  const shardsPrefix = `${JOB_ID}/shards`;

  await downloadDir(REPORT_BUCKET, shardsPrefix, workDir);

  const { htmlDir, junitFile } = await mergeReports(workDir);

  await uploadDir(REPORT_BUCKET, htmlDir, `${JOB_ID}/final/html`);
  await uploadDir(REPORT_BUCKET, junitFile, `${JOB_ID}/final/junit.xml`);

  const urls = await generateSignedUrls(REPORT_BUCKET, JOB_ID);
  console.log("🔗 Signed URLs:", urls);

  await cleanupBlobs(REPORT_BUCKET, shardsPrefix);

  console.log("✅ Merge + cleanup done");
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
