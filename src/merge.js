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
function repoNameFromUrl(url) {
  const clean = url.replace(/\/+$/, "");
  const last = clean.split("/").pop() || "repo";
  return last.replace(/\.git$/i, "");
}

async function downloadPrefix(bucketName, prefix, localDir) {
  const bucket = storage.bucket(bucketName);
  fs.mkdirSync(localDir, { recursive: true });

  const [files] = await bucket.getFiles({ prefix });
  if (!files.length)
    throw new Error(`No files found in gs://${bucketName}/${prefix}`);

  for (const f of files) {
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
const getTimestamp = () => {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
};

async function deletePrefix(bucketName, prefix) {
  const bucket = storage.bucket(bucketName);
  let pageToken = undefined;
  let deleted = 0;

  elog(`🧹 Cleaning up: gs://${bucketName}/${prefix}`);

  while (true) {
    const [files, , resp] = await bucket.getFiles({ prefix, pageToken });
    if (!files.length) break;

    const batchSize = 100;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((f) => f.delete()));
      deleted += batch.length;
    }

    pageToken = resp?.nextPageToken;
    if (!pageToken) break;
  }

  elog(`✅ Cleanup done. Deleted ~${deleted} objects under ${prefix}`);
}

async function main() {
  const bucketName = process.env.REPORT_BUCKET;
  const runId = process.env.RUN_ID;

  if (!bucketName) throw new Error("REPORT_BUCKET missing");
  if (!runId) throw new Error("JOB_ID (RUN_ID) missing for merge");

  const workDir = path.join(os.tmpdir(), runId);
  const blobsPrefix = `${runId}/blobs/`;
  const workspacePrefix = `${runId}/workspace/`;
  const localBlobsDir = path.join(workDir, "blobs");

  elog(`🧩 Merge start`);
  elog(`🪣 bucket=${bucketName}`);
  elog(`🆔 runId=${runId}`);
  elog(
    `📥 Downloading blobs: gs://${bucketName}/${blobsPrefix} → ${localBlobsDir}`,
  );

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  await downloadPrefix(bucketName, blobsPrefix, localBlobsDir);

  const entries = fs.readdirSync(localBlobsDir);
  elog(`📂 Local blobs entries (${entries.length}): ${entries.join(", ")}`);

  const mergeCmd = `npx playwright merge-reports --reporter html "${localBlobsDir}"`;
  elog(`🖥️ Running: ${mergeCmd}`);
  execSync(mergeCmd, { stdio: "inherit", env: { ...process.env, CI: "1" } });

  const defaultReportDir = path.join(process.cwd(), "playwright-report");
  if (!fs.existsSync(defaultReportDir)) {
    throw new Error(
      `Expected merged html folder not found: ${defaultReportDir}`,
    );
  }

  const mergedHtmlDir = path.join(workDir, "final-html");
  fs.rmSync(mergedHtmlDir, { recursive: true, force: true });
  fs.renameSync(defaultReportDir, mergedHtmlDir);

  const indexPath = path.join(mergedHtmlDir, "index.html");
  if (!fs.existsSync(indexPath))
    throw new Error(`Merged HTML index not found: ${indexPath}`);
  const repoName = repoNameFromUrl(process.env.TEST_REPO_URL);
  const destPrefix = `${repoName}/${getTimestamp()}/html/`;
  elog(
    `📤 Uploading merged html: ${mergedHtmlDir} → gs://${bucketName}/${destPrefix}`,
  );
  await uploadDir(bucketName, mergedHtmlDir, destPrefix);

  elog(
    `✅ Uploaded HTML: gs://${bucketName}/${runId}/${repoName}/html/index.html`,
  );

  await cleanupRun(
    bucketName,
    blobsPrefix,
    process.env.WORKSPACE_BUCKET,
    workspacePrefix,
  );
  elog("====================================================");
  elog("✅ MERGE COMPLETED + BLOBS CLEANED");
  elog(`📍 HTML: gs://${bucketName}/${runId}/${repoName}/html/index.html`);
  elog("====================================================");
}
export async function cleanupRun(
  blobsBucket,
  blobsPrefix,
  workspaceBucket,
  workspacePrefix,
) {
  await deletePrefix(blobsBucket, `${blobsPrefix}`);
  await deletePrefix(workspaceBucket, `${workspacePrefix}`);
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
