import { Storage } from "@google-cloud/storage";
import { cleanupBlobs } from "./cleanup.js";
import { downloadDir, uploadDir } from "./gcs.js";
import { mergePlaywrightReports } from "./mergePlaywright.js";

const storage = new Storage();
const { JOB_ID, REPORT_BUCKET } = process.env;

async function main() {
  if (!JOB_ID) throw new Error("JOB_ID missing");
  if (!REPORT_BUCKET) throw new Error("REPORT_BUCKET missing");

  console.log("🧩 Merging reports");

  const workDir = `/tmp/${JOB_ID}`;
  const blobsPrefix = `${JOB_ID}/blobs`;
  const localBlobsDir = `${workDir}/blobs`;

  // Download flat blob zips into /tmp/<JOB_ID>/blobs
  await downloadDir(REPORT_BUCKET, blobsPrefix, localBlobsDir);

  const { htmlDir, junitPath } = mergePlaywrightReports({
    allBlobDir: localBlobsDir,
    mergedDir: workDir,
  });

  await uploadDir(REPORT_BUCKET, htmlDir, `${JOB_ID}/final/html`);

  // Upload JUnit as a file (not a directory)
  await storage.bucket(REPORT_BUCKET).upload(junitPath, {
    destination: `${JOB_ID}/final/junit.xml`,
  });

  // Optional: cleanup blobs after successful merge
  await cleanupBlobs(REPORT_BUCKET, blobsPrefix);

  console.log("✅ Merge + cleanup done");
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
