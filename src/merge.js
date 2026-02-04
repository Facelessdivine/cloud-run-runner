// src/merge.js
import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSummaryFromJUnit } from "./summary.js";
import { cleanupRun } from "./cleanup.js";

const storage = new Storage();

function repoNameFromUrl(url) {
  const clean = String(url || "").replace(/\/+$/, "");
  const last = clean.split("/").pop() || "repo";
  return last.replace(/\.git$/i, "");
}
function safeSegment(s) {
  return String(s || "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "unknown";
}
function ymdUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function downloadPrefix(bucketName, prefix, localDir) {
  const bucket = storage.bucket(bucketName);
  fs.mkdirSync(localDir, { recursive: true });
  const [files] = await bucket.getFiles({ prefix });
  if (!files.length) return [];
  const downloaded = [];
  for (const f of files) {
    const rel = f.name.slice(prefix.length);
    if (!rel) continue;
    const dest = path.join(localDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await f.download({ destination: dest });
    downloaded.push(dest);
  }
  return downloaded;
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
  for (const filePath of files) {
    const rel = path.relative(localDir, filePath).replace(/\\/g, "/");
    await bucket.upload(filePath, { destination: `${destPrefix}/${rel}` });
  }
}

async function uploadFile(bucketName, localPath, destPath) {
  const bucket = storage.bucket(bucketName);
  await bucket.upload(localPath, { destination: destPath });
}

function extractTestSuites(xmlText) {
  // Extract <testsuite ...>...</testsuite> blocks
  const suites = [];
  const reSuite = /<testsuite[\s\S]*?<\/testsuite>/g;
  let m;
  while ((m = reSuite.exec(xmlText)) !== null) suites.push(m[0]);
  // If none, maybe root is <testsuites> without suites; just return empty
  return suites;
}

function mergeJunitFiles(junitFiles, outFile) {
  const suites = [];
  for (const jf of junitFiles) {
    const txt = fs.readFileSync(jf, "utf-8");
    const s = extractTestSuites(txt);
    if (s.length) suites.push(...s);
  }
  if (!suites.length) return false;
  const merged = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join("\n")}\n</testsuites>\n`;
  fs.writeFileSync(outFile, merged, "utf-8");
  return true;
}

async function main() {
  const bucketName = process.env.REPORTS_BUCKET || process.env.REPORT_BUCKET;
  const runId = process.env.RUN_ID || process.env.JOB_ID;
  if (!bucketName) throw new Error("REPORTS_BUCKET (or REPORT_BUCKET) missing");
  if (!runId) throw new Error("RUN_ID missing for merge");

  const testRepoUrl = process.env.TEST_REPO_URL;
  const project = safeSegment(process.env.PROJECT_NAME || repoNameFromUrl(testRepoUrl));
  const branch = safeSegment(process.env.BRANCH_NAME || process.env.TEST_REPO_REF || "main");
  const runDate = safeSegment(process.env.RUN_DATE || ymdUtc());

  const workDir = path.join(os.tmpdir(), runId, "merge");
  const blobsPrefix = `${runId}/blobs/`;
  const junitPrefix = `${runId}/junit/`;
  const workspacePrefix = `${runId}/workspace/`;

  const localBlobsDir = path.join(workDir, "blobs");
  const localJunitDir = path.join(workDir, "junit");
  const mergedDir = path.join(workDir, "merged");
  const junitOut = path.join(mergedDir, "results.xml");
  const summaryOut = path.join(mergedDir, "summary.json");

  console.log("🧬 Merge coordinator starting");
  console.log(`🪣 bucket=${bucketName}`);
  console.log(`🆔 runId=${runId}`);
  console.log(`📦 project=${project} branch=${branch} date=${runDate}`);

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(localBlobsDir, { recursive: true });
  fs.mkdirSync(localJunitDir, { recursive: true });
  fs.mkdirSync(mergedDir, { recursive: true });

  console.log(`📥 Download blobs: gs://${bucketName}/${blobsPrefix} → ${localBlobsDir}`);
  await downloadPrefix(bucketName, blobsPrefix, localBlobsDir);

  console.log(`📥 Download junit: gs://${bucketName}/${junitPrefix} → ${localJunitDir}`);
  const junitDownloaded = await downloadPrefix(bucketName, junitPrefix, localJunitDir);

  const startedAt = process.env.RUN_STARTED_AT || new Date().toISOString();

  console.log("🖥️ Running merge-reports (HTML)");
  execSync(`npx playwright merge-reports --reporter html "${localBlobsDir}"`, {
    stdio: "inherit",
    env: { ...process.env, CI: "1" },
    cwd: mergedDir,
  });

  const htmlDir = path.join(mergedDir, "playwright-report");
  if (!fs.existsSync(path.join(htmlDir, "index.html"))) {
    throw new Error(`Merged HTML index.html not found at ${htmlDir}`);
  }

  // Merge junit (from per-shard junit uploads)
  const junitFiles = [];
  for (const p of junitDownloaded) {
    if (p.endsWith(".xml")) junitFiles.push(p);
  }
  if (!junitFiles.length) {
    console.warn("⚠️ No junit shard XML files were downloaded. Creating a minimal placeholder results.xml.");
    fs.writeFileSync(junitOut, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites/>\n`, "utf-8");
  } else {
    const ok = mergeJunitFiles(junitFiles, junitOut);
    if (!ok) {
      console.warn("⚠️ Could not merge junit suites; writing placeholder results.xml");
      fs.writeFileSync(junitOut, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites/>\n`, "utf-8");
    }
  }

  const finishedAt = process.env.RUN_FINISHED_AT || new Date().toISOString();

  const basePrefix = `reports/${project}/${branch}/${runDate}/${runId}`;
  const htmlPrefix = `${basePrefix}/final/html`;
  const junitPath = `${basePrefix}/final/results.xml`;
  const summaryPath = `${basePrefix}/summary.json`;

  const commit = process.env.CI_COMMIT_SHA || process.env.GITHUB_SHA || process.env.COMMIT_SHA || undefined;
  const shards = Number(process.env.CLOUD_RUN_TASK_COUNT || process.env.SHARDS || 1) || 1;

  const summary = buildSummaryFromJUnit({
    runId,
    project,
    branch,
    commit,
    startedAt,
    finishedAt,
    shards,
    junitLocalPath: junitOut,
    htmlPrefixInBucket: htmlPrefix,
    junitPathInBucket: junitPath,
    meta: {
      pipelineId: process.env.CI_PIPELINE_ID,
      jobId: process.env.CI_JOB_ID,
      buildUrl: process.env.CI_PIPELINE_URL,
    },
  });

  fs.writeFileSync(summaryOut, JSON.stringify(summary, null, 2), "utf-8");

  console.log(`📤 Uploading merged html → gs://${bucketName}/${htmlPrefix}/`);
  await uploadDir(bucketName, htmlDir, htmlPrefix);

  console.log(`📤 Uploading merged junit → gs://${bucketName}/${junitPath}`);
  await uploadFile(bucketName, junitOut, junitPath);

  console.log(`📤 Uploading summary.json → gs://${bucketName}/${summaryPath}`);
  await uploadFile(bucketName, summaryOut, summaryPath);

  // Cleanup
  await cleanupRun(bucketName, blobsPrefix, process.env.WORKSPACE_BUCKET || bucketName, workspacePrefix);
  // also cleanup junit prefix
  await cleanupRun(bucketName, junitPrefix, bucketName, "");

  console.log("====================================================");
  console.log("✅ MERGE COMPLETED + UPLOADED FOR DASHBOARD");
  console.log(`📍 HTML: gs://${bucketName}/${htmlPrefix}/index.html`);
  console.log(`📍 JUnit: gs://${bucketName}/${junitPath}`);
  console.log(`📍 Summary: gs://${bucketName}/${summaryPath}`);
  console.log("====================================================");
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
