// src/merge.js
import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const storage = new Storage();

function elog(...args) {
  console.error(...args);
}

async function downloadPrefix(bucketName, prefix, localDir) {
  const bucket = storage.bucket(bucketName);
  fs.mkdirSync(localDir, { recursive: true });

  const [files] = await bucket.getFiles({ prefix });
  if (!files.length) {
    throw new Error(`No files found in gs://${bucketName}/${prefix}`);
  }

  for (const f of files) {
    // Keep relative structure under prefix
    const rel = f.name.slice(prefix.length);
    if (!rel) continue;

    const destPath = path.join(localDir, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await f.download({ destination: destPath });
  }
}

async function uploadDir(bucketName, localDir, destPrefix) {
  const bucket = storage.bucket(bucketName);

  const walk = (dir) => {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };

  const files = walk(localDir);
  if (!files.length) throw new Error(`Nothing to upload from ${localDir}`);

  for (const filePath of files) {
    const rel = path.relative(localDir, filePath).replace(/\\/g, "/");
    const dest = `${destPrefix}${rel}`;
    await bucket.upload(filePath, { destination: dest });
  }
}

async function main() {
  const bucketName = process.env.REPORT_BUCKET;
  const runId = process.env.JOB_ID || process.env.RUN_ID;

  if (!bucketName) throw new Error("REPORT_BUCKET missing");
  if (!runId) throw new Error("JOB_ID (RUN_ID) missing for merge");

  const workDir = path.join(os.tmpdir(), runId);
  const blobsPrefix = `${runId}/blobs/`;
  const localBlobsDir = path.join(workDir, "blobs");

  elog(`🧩 Merge start`);
  elog(`🪣 bucket=${bucketName}`);
  elog(`🆔 runId=${runId}`);
  elog(
    `📥 Downloading blobs: gs://${bucketName}/${blobsPrefix} → ${localBlobsDir}`,
  );

  // Fresh workspace
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  await downloadPrefix(bucketName, blobsPrefix, localBlobsDir);

  // Confirm we have shard zips
  const blobFiles = fs.readdirSync(localBlobsDir);
  elog(`📂 Local blobs entries (${blobFiles.length}): ${blobFiles.join(", ")}`);

  // Merge output directory
  const mergedHtmlDir = path.join(workDir, "final-html");
  fs.mkdirSync(mergedHtmlDir, { recursive: true });

  // IMPORTANT: Use the same Playwright version already installed in the image.
  // This should work if your runner has playwright in dependencies.
  const mergeCmd = `npx playwright merge-reports --reporter html "${localBlobsDir}"`;
  elog(`🖥️ Running: ${mergeCmd}`);

  execSync(mergeCmd, {
    stdio: "inherit",
    env: {
      ...process.env,
      // Force output to default playwright folder "playwright-report"
      // We'll move it to mergedHtmlDir afterwards.
      CI: "1",
    },
  });

  // Playwright writes to ./playwright-report by default
  const defaultReportDir = path.join(process.cwd(), "playwright-report");
  if (!fs.existsSync(defaultReportDir)) {
    throw new Error(
      `Expected merged html folder not found: ${defaultReportDir}`,
    );
  }

  // Move report into our work dir
  fs.rmSync(mergedHtmlDir, { recursive: true, force: true });
  fs.renameSync(defaultReportDir, mergedHtmlDir);

  const indexPath = path.join(mergedHtmlDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Merged HTML index not found at ${indexPath}`);
  }

  const destPrefix = `${runId}/final/html/`;
  elog(
    `📤 Uploading merged html: ${mergedHtmlDir} → gs://${bucketName}/${destPrefix}`,
  );

  await uploadDir(bucketName, mergedHtmlDir, destPrefix);

  elog("====================================================");
  elog("✅ MERGE COMPLETED");
  elog(`📍 HTML: gs://${bucketName}/${runId}/final/html/index.html`);
  elog("====================================================");
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
