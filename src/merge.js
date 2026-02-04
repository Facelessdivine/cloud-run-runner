// src/merge.js
import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSummary } from "./summary.js";

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
  if (!files.length) throw new Error(`No files found in gs://${bucketName}/${prefix}`);

  for (const f of files) {
    const rel = f.name.slice(prefix.length);
    if (!rel) continue;
    const destPath = path.join(localDir, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await f.download({ destination: destPath });
  }
}

async function uploadDir(bucketName, localDir, destPrefixWithTrailingSlash) {
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
    const dest = `${destPrefixWithTrailingSlash}${rel}`;
    await bucket.upload(filePath, { destination: dest });
  }
}

async function uploadFile(bucketName, localPath, destPath) {
  const bucket = storage.bucket(bucketName);
  await bucket.upload(localPath, { destination: destPath });
}

async function deletePrefix(bucketName, prefix) {
  const bucket = storage.bucket(bucketName);
  let pageToken = undefined;
  let deleted = 0;

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

  console.log(`✅ Cleanup done. Deleted ~${deleted} objects under ${prefix}`);
}

export async function cleanupRun(blobsBucket, blobsPrefix, workspaceBucket, workspacePrefix) {
  await deletePrefix(blobsBucket, blobsPrefix);
  if (workspaceBucket && workspacePrefix) await deletePrefix(workspaceBucket, workspacePrefix);
}

function findFirstXml(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".xml")) return p;
    if (e.isDirectory()) {
      const sub = findFirstXml(p);
      if (sub) return sub;
    }
  }
  return null;
}

async function main() {
  const bucketName = process.env.REPORTS_BUCKET || process.env.REPORT_BUCKET;
  const runId = process.env.RUN_ID || process.env.JOB_ID;

  if (!bucketName) throw new Error("REPORTS_BUCKET (or REPORT_BUCKET) missing");
  if (!runId) throw new Error("RUN_ID missing for merge");

  const testRepoUrl = process.env.TEST_REPO_URL;
  const repoName = safeSegment(process.env.PROJECT_NAME || repoNameFromUrl(testRepoUrl));
  const branchName = safeSegment(process.env.BRANCH_NAME || process.env.TEST_REPO_REF || "main");
  const runDate = safeSegment(process.env.RUN_DATE || ymdUtc());

  const shards = Number(process.env.CLOUD_RUN_TASK_COUNT || process.env.SHARDS || 1) || 1;

  const workDir = path.join(os.tmpdir(), runId, "merge");
  const blobsPrefix = `${runId}/blobs/`;
  const workspacePrefix = `${runId}/workspace/`;

  const localBlobsDir = path.join(workDir, "blobs");
  const mergedDir = path.join(workDir, "merged");
  const mergedHtmlDir = path.join(mergedDir, "playwright-report"); // we will move here
  const junitOut = path.join(mergedDir, "results.xml");
  const summaryOut = path.join(mergedDir, "summary.json");

  console.log("🧬 Merge coordinator starting");
  console.log(`🪣 bucket=${bucketName}`);
  console.log(`🆔 runId=${runId}`);
  console.log(`📦 project=${repoName}  branch=${branchName}  date=${runDate}`);

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(localBlobsDir, { recursive: true });
  fs.mkdirSync(mergedDir, { recursive: true });

  console.log(`📥 Download blobs: gs://${bucketName}/${blobsPrefix} → ${localBlobsDir}`);
  await downloadPrefix(bucketName, blobsPrefix, localBlobsDir);

  const startedAt = process.env.RUN_STARTED_AT || new Date().toISOString();

  // 1) Merge HTML (Playwright creates ./playwright-report under CWD)
  console.log("🖥️ Running merge-reports (HTML)");
  execSync(`npx playwright merge-reports --reporter html "${localBlobsDir}"`, {
    stdio: "inherit",
    env: { ...process.env, CI: "1" },
    cwd: mergedDir,
  });

  const defaultHtmlDir = path.join(mergedDir, "playwright-report");
  if (!fs.existsSync(defaultHtmlDir)) throw new Error(`Expected merged html not found: ${defaultHtmlDir}`);
  if (!fs.existsSync(path.join(defaultHtmlDir, "index.html"))) throw new Error("Merged HTML index.html not found");

  // 2) Merge JUnit (best-effort). We run in mergedDir so results.xml is local there.
  // We'll use config to force junit output file.
  const mergeCfg = path.join(mergedDir, "pw.merge.config.cjs");
  fs.writeFileSync(
    mergeCfg,
    `module.exports = { reporter: [[ "junit", { outputFile: "results.xml" } ]] };\n`,
    "utf-8",
  );

  console.log("🧾 Running merge-reports (JUnit)");
  try {
    execSync(`npx playwright merge-reports -c "${mergeCfg}" --reporter junit "${localBlobsDir}"`, {
      stdio: "inherit",
      env: { ...process.env, CI: "1" },
      cwd: mergedDir,
    });
  } catch (e) {
    console.warn("⚠️ JUnit merge command failed; will try to locate any .xml output.", e?.message || e);
  }

  let junitFile = junitOut;
  if (!fs.existsSync(junitFile)) {
    const alt = findFirstXml(mergedDir);
    if (alt) {
      console.warn(`⚠️ results.xml not found at expected path; using ${alt}`);
      junitFile = alt;
    } else {
      throw new Error("Could not find any junit xml output after merge.");
    }
  }

  const finishedAt = process.env.RUN_FINISHED_AT || new Date().toISOString();
  const durationSec = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));

  // Dashboard-compatible destination
  const basePrefix = `reports/${repoName}/${branchName}/${runDate}/${runId}`;
  const htmlPrefix = `${basePrefix}/final/html`;
  const junitPath = `${basePrefix}/final/results.xml`;
  const summaryPath = `${basePrefix}/summary.json`;

  // Build summary.json
  const commit = process.env.CI_COMMIT_SHA || process.env.GITHUB_SHA || process.env.COMMIT_SHA || undefined;

  const summary = buildSummary({
    runId,
    project: repoName,
    branch: branchName,
    commit,
    startedAt,
    finishedAt,
    durationSec,
    shards,
    junitLocalPath: junitFile,
    htmlPrefixInBucket: htmlPrefix,
    junitPathInBucket: junitPath,
    meta: {
      pipelineId: process.env.CI_PIPELINE_ID,
      jobId: process.env.CI_JOB_ID,
      buildUrl: process.env.CI_PIPELINE_URL || process.env.BUILD_URL,
      executionId: process.env.CLOUD_RUN_EXECUTION || process.env.CLOUD_RUN_EXECUTION_ID,
    },
  });

  fs.writeFileSync(summaryOut, JSON.stringify(summary, null, 2), "utf-8");

  // Upload artifacts for dashboard
  console.log(`📤 Upload HTML: ${defaultHtmlDir} → gs://${bucketName}/${htmlPrefix}/`);
  await uploadDir(bucketName, defaultHtmlDir, `${htmlPrefix}/`);

  console.log(`📤 Upload JUnit: ${junitFile} → gs://${bucketName}/${junitPath}`);
  await uploadFile(bucketName, junitFile, junitPath);

  console.log(`📤 Upload summary: ${summaryOut} → gs://${bucketName}/${summaryPath}`);
  await uploadFile(bucketName, summaryOut, summaryPath);

  // Cleanup shard blobs + workspace
  await cleanupRun(bucketName, blobsPrefix, process.env.WORKSPACE_BUCKET || bucketName, workspacePrefix);

  console.log("====================================================");
  console.log("✅ MERGE COMPLETED");
  console.log(`📍 Dashboard prefix: gs://${bucketName}/${basePrefix}/`);
  console.log(`📍 HTML index: gs://${bucketName}/${htmlPrefix}/index.html`);
  console.log(`📍 JUnit: gs://${bucketName}/${junitPath}`);
  console.log(`📍 Summary: gs://${bucketName}/${summaryPath}`);
  console.log("====================================================");
}

main().catch((err) => {
  console.error("❌ Merge failed", err);
  process.exit(1);
});
