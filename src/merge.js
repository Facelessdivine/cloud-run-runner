// src/merge.js
import { Storage } from "@google-cloud/storage";
import fs from "node:fs";
import path from "node:path";

import { mergePlaywrightReports } from "./mergePlaywright.js";

const storage = new Storage();

const { JOB_ID, REPORT_BUCKET } = process.env;

async function main() {
  console.log("🧩 Merging reports");

  if (!JOB_ID) throw new Error("JOB_ID missing");
  if (!REPORT_BUCKET) throw new Error("REPORT_BUCKET missing");

  // Local work dir (deterministic)
  const workRoot = `/tmp/pw-merge/${JOB_ID}`;
  const downloadDir = path.join(workRoot, "download");
  const allBlobDir = path.join(workRoot, "all-blob");
  const mergedDir = path.join(workRoot, "merged");

  fs.mkdirSync(downloadDir, { recursive: true });
  fs.mkdirSync(allBlobDir, { recursive: true });
  fs.mkdirSync(mergedDir, { recursive: true });

  const shardsPrefix = `${JOB_ID}/shards/`; // MUST end with /
  console.log(`📥 Downloading gs://${REPORT_BUCKET}/${shardsPrefix}`);

  // 1) Download shard artifacts
  await downloadPrefixToDir(REPORT_BUCKET, shardsPrefix, downloadDir);

  // 2) Flatten all .zip blob files into all-blob/
  const zips = collectZipFiles(downloadDir);
  console.log(`📦 Found ${zips.length} zip files`);
  if (zips.length === 0) {
    throw new Error(
      `No .zip files found under downloaded shards. Prefix=gs://${REPORT_BUCKET}/${shardsPrefix}`,
    );
  }

  for (const f of zips) {
    const base = path.basename(f);
    fs.copyFileSync(f, path.join(allBlobDir, base));
  }

  // 3) Merge (HTML + JUnit)
  const { htmlDir, junitPath } = mergePlaywrightReports({
    allBlobDir,
    mergedDir,
  });

  // 4) Upload final outputs
  const htmlDestPrefix = `${JOB_ID}/final/html`;
  const junitDest = `${JOB_ID}/final/junit.xml`;

  console.log(`📤 Uploading HTML to gs://${REPORT_BUCKET}/${htmlDestPrefix}/`);
  await uploadDir(REPORT_BUCKET, htmlDir, htmlDestPrefix);

  console.log(`📤 Uploading JUnit to gs://${REPORT_BUCKET}/${junitDest}`);
  await storage
    .bucket(REPORT_BUCKET)
    .upload(junitPath, { destination: junitDest });

  console.log("✅ Merge upload complete");
  console.log(`📍 HTML: gs://${REPORT_BUCKET}/${JOB_ID}/final/html/index.html`);
  console.log(`📍 JUnit: gs://${REPORT_BUCKET}/${JOB_ID}/final/junit.xml`);
}

// -------- helpers --------

async function downloadPrefixToDir(bucketName, prefix, destDir) {
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix });

  for (const file of files) {
    if (file.name.endsWith("/")) continue;

    // preserve relative path under prefix
    const rel = file.name.slice(prefix.length);
    const outPath = path.join(destDir, rel);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await file.download({ destination: outPath });
  }
}

function collectZipFiles(dir) {
  const out = [];
  walk(dir, out);
  return out.filter((f) => f.endsWith(".zip"));
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

async function uploadDir(bucketName, localDir, destPrefix) {
  const bucket = storage.bucket(bucketName);
  const files = [];
  walk(localDir, files);

  await Promise.all(
    files.map(async (full) => {
      const rel = path.relative(localDir, full).replaceAll("\\", "/");
      const dest = `${destPrefix}/${rel}`;
      await bucket.upload(full, { destination: dest });
    }),
  );
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
