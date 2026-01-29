import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { deletePrefix, downloadPrefix, uploadDir, uploadFile } from "./gcs.js";
import { signedUrl } from "./signed-urls.js";

const bucket = process.env.BUCKET;
const runId = process.env.RUN_ID;
const CNT = process.env.CLOUD_RUN_TASK_COUNT || 1;

const work = "/merge";
fs.mkdirSync(work, { recursive: true });
process.chdir(work);

console.log("👑 Waiting for shards...");

while (true) {
  const { Storage } = await import("@google-cloud/storage");
  const storage = new Storage();
  const [files] = await storage
    .bucket(bucket)
    .getFiles({ prefix: `runs/${runId}/blob/shard-` });

  const shards = new Set(files.map((f) => f.name.split("/")[3]));
  console.log(`Found ${shards.size}/${CNT}`);
  if (shards.size >= CNT) break;
  await new Promise((r) => setTimeout(r, 5000));
}

console.log("📥 Downloading blobs...");
await downloadPrefix(bucket, `runs/${runId}/blob/`, "./blob");

console.log("📦 Collecting zip files...");
fs.mkdirSync("./all-blob", { recursive: true });
for (const f of fs.readdirSync("./blob", { recursive: true })) {
  if (f.endsWith(".zip")) {
    fs.copyFileSync(
      path.join("./blob", f),
      path.join("./all-blob", path.basename(f)),
    );
  }
}

console.log("🖥️ Generating HTML report...");
execSync("npx playwright merge-reports --reporter html ./all-blob", {
  stdio: "inherit",
});

console.log("📄 Generating JUnit report...");
try {
  execSync(
    "npx playwright merge-reports --reporter junit ./all-blob > ./results.xml",
    {
      stdio: "inherit",
      shell: "/bin/bash",
    },
  );
} catch {
  fs.writeFileSync(
    "./results.xml",
    '<?xml version="1.0" encoding="UTF-8"?><testsuites></testsuites>',
  );
}

console.log("📤 Uploading merged HTML...");
await uploadDir("./playwright-report", bucket, `runs/${runId}/final/html`);

console.log("📤 Uploading merged JUnit...");
await uploadFile("./results.xml", bucket, `runs/${runId}/final/junit.xml`);

console.log("🔐 Generating signed URLs...");
const htmlUrl = await signedUrl(
  bucket,
  `runs/${runId}/final/html/index.html`,
  120,
);
const junitUrl = await signedUrl(bucket, `runs/${runId}/final/junit.xml`, 120);

console.log("====================================================");
console.log("✅ REPORTS READY");
console.log("🌐 HTML:", htmlUrl);
console.log("🧾 JUnit:", junitUrl);
console.log("====================================================");

console.log("🧹 Cleaning blob files...");
await deletePrefix(bucket, `runs/${runId}/blob/`);
