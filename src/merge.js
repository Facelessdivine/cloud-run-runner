// src/merge.js
import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const storage = new Storage();

const { JOB_ID, REPORT_BUCKET } = process.env;

async function main() {
  console.log("🧩 Merging reports");

  if (!JOB_ID) throw new Error("JOB_ID missing");
  if (!REPORT_BUCKET) throw new Error("REPORT_BUCKET missing");

  const workRoot = `/tmp/pw-merge/${JOB_ID}`;
  const downloadDir = path.join(workRoot, "download");
  const allBlobDir = path.join(workRoot, "all-blob");
  const mergedDir = path.join(workRoot, "merged");

  fs.mkdirSync(downloadDir, { recursive: true });
  fs.mkdirSync(allBlobDir, { recursive: true });
  fs.mkdirSync(mergedDir, { recursive: true });

  // 1) Download everything under shards/
  const shardsPrefix = `${JOB_ID}/shards/`;
  console.log(`📥 Downloading gs://${REPORT_BUCKET}/${shardsPrefix}`);
  await downloadPrefixToDir(REPORT_BUCKET, shardsPrefix, downloadDir);

  // 2) Collect ONLY blob-report zips: report-*.zip (ignore trace.zip etc.)
  const zips = collectReportZips(downloadDir);
  console.log(`📦 Found ${zips.length} blob report zip files`);
  if (!zips.length) {
    throw new Error(
      "No report-*.zip files found for merge (blob reporter missing?)",
    );
  }

  // 3) Flatten into all-blob/ (unique names)
  let n = 0;
  for (const f of zips) {
    n += 1;
    fs.copyFileSync(f, path.join(allBlobDir, `blob-${n}-${path.basename(f)}`));
  }

  // 4) Merge (HTML output goes to mergedDir/playwright-report)
  console.log("🖥️ Generating HTML report...");
  execSync(`npx playwright merge-reports --reporter html "${allBlobDir}"`, {
    stdio: "inherit",
    cwd: mergedDir,
  });

  console.log("📄 Generating JUnit report...");
  const junit = execSync(
    `npx playwright merge-reports --reporter junit "${allBlobDir}"`,
    {
      encoding: "utf8",
      cwd: mergedDir,
    },
  );

  const junitPath = path.join(mergedDir, "results.xml");
  fs.writeFileSync(
    junitPath,
    junit || '<?xml version="1.0" encoding="UTF-8"?><testsuites></testsuites>',
  );

  // 5) Upload merged outputs
  const htmlDir = path.join(mergedDir, "playwright-report");
  if (!fs.existsSync(htmlDir))
    throw new Error(`Missing HTML output folder: ${htmlDir}`);

  console.log(`📤 Uploading merged HTML...`);
  await uploadDir(REPORT_BUCKET, htmlDir, `${JOB_ID}/final/html`);

  console.log(`📤 Uploading merged JUnit...`);
  await storage.bucket(REPORT_BUCKET).upload(junitPath, {
    destination: `${JOB_ID}/final/junit.xml`,
  });

  console.log("✅ Merge upload complete");
  console.log(`📍 HTML: gs://${REPORT_BUCKET}/${JOB_ID}/final/html/index.html`);
  console.log(`📍 JUnit: gs://${REPORT_BUCKET}/${JOB_ID}/final/junit.xml`);
}

async function downloadPrefixToDir(bucketName, prefix, destDir) {
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix });

  for (const file of files) {
    if (file.name.endsWith("/")) continue;
    const rel = file.name.slice(prefix.length);
    const out = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await file.download({ destination: out });
  }
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function collectReportZips(dir) {
  const files = [];
  walk(dir, files);

  // Key rule: ONLY merge blob zips (report-*.zip). Never merge trace.zip.
  return files.filter((f) => {
    const base = path.basename(f);
    return base.startsWith("report-") && base.endsWith(".zip");
  });
}

async function uploadDir(bucketName, localDir, destPrefix) {
  const bucket = storage.bucket(bucketName);
  const files = [];
  walk(localDir, files);

  for (const full of files) {
    const rel = path.relative(localDir, full).replaceAll("\\", "/");
    await bucket.upload(full, { destination: `${destPrefix}/${rel}` });
  }
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
