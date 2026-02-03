// src/workspace.js
import { Storage } from "@google-cloud/storage";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cloneRepo } from "./git.js";

const storage = new Storage();

function repoNameFromUrl(url) {
  const clean = String(url || "").replace(/\/+$/, "");
  const last = clean.split("/").pop() || "repo";
  return last.replace(/\.git$/i, "");
}

function safe(s) {
  return String(s || "run").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ensures all tasks use the same prepared workspace:
 * - Task 0: clones + installs once, tars workspace, uploads to GCS, writes READY marker.
 * - Other tasks: wait for READY marker, download tar, extract locally.
 *
 * This replaces per-shard clone+install, which is the biggest runtime bottleneck.
 */
export async function ensureWorkspace({
  repoUrl,
  repoRef,
  bucketName,
  runId,
  timeoutMs = 10 * 60 * 1000,
}) {
  if (!repoUrl) throw new Error("repoUrl missing");
  if (!bucketName) throw new Error("bucketName missing");
  if (!runId) throw new Error("runId missing");

  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX || 0);
  const repoName = repoNameFromUrl(repoUrl);

  const basePrefix = `${runId}/workspace`;
  const tgzObject = `${basePrefix}/workspace.tgz`;
  const readyObject = `${basePrefix}/_READY.txt`;

  const bucket = storage.bucket(bucketName);

  // Local paths per-task (no sharing between tasks)
  const localRoot = path.join(os.tmpdir(), `pw-workspace-${safe(runId)}`);
  const localTgz = path.join(localRoot, "workspace.tgz");
  fs.mkdirSync(localRoot, { recursive: true });

  // Use a deterministic local path across ALL tasks so Playwright blob metadata matches.
  const extractRoot = path.join(localRoot, "extracted");
  const extractedRepoDir = path.join(extractRoot, repoName);

  fs.mkdirSync(extractRoot, { recursive: true });

  if (taskIndex === 0) {
    console.log(`🧰 [workspace] task0 preparing workspace for ${repoUrl}@${repoRef}`);

    // Clone + install ONCE (only in task 0)
    const repoDir = await cloneRepo(repoUrl, repoRef, extractedRepoDir);

    // Create tarball (include node_modules for fastest fan-out)
    // Exclude VCS + common output dirs to keep the artifact smaller.
    const parent = path.dirname(repoDir);
    const folder = path.basename(repoDir);

    console.log(`📦 [workspace] creating tarball: ${localTgz}`);
    execSync(
      [
        "tar",
        "-czf",
        localTgz,
        "--exclude=.git",
        "--exclude=playwright-report",
        "--exclude=test-results",
        "--exclude=blob-report",
        "-C",
        parent,
        folder,
      ].join(" "),
      { stdio: "inherit" },
    );

    console.log(`☁️ [workspace] uploading: gs://${bucketName}/${tgzObject}`);
    await bucket.upload(localTgz, {
      destination: tgzObject,
      resumable: false,
      contentType: "application/gzip",
      metadata: { cacheControl: "no-store" },
    });

    console.log(`📝 [workspace] writing READY marker: gs://${bucketName}/${readyObject}`);
    await bucket.file(readyObject).save(`${new Date().toISOString()}\n`, {
      resumable: false,
      contentType: "text/plain",
      metadata: { cacheControl: "no-store" },
    });

    return repoDir;
  }

  console.log(`⏳ [workspace] waiting READY marker: gs://${bucketName}/${readyObject}`);

  const start = Date.now();
  while (true) {
    const [exists] = await bucket.file(readyObject).exists().catch(() => [false]);
    if (exists) break;

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for workspace READY marker gs://${bucketName}/${readyObject}`,
      );
    }
    await sleep(2000);
  }

  console.log(`⬇️ [workspace] downloading: gs://${bucketName}/${tgzObject} → ${localTgz}`);
  await bucket.file(tgzObject).download({ destination: localTgz });
  // Extract into the deterministic extractRoot
console.log(`📂 [workspace] extracting into: ${extractRoot}`);
  execSync(["tar", "-xzf", localTgz, "-C", extractRoot].join(" "), {
    stdio: "inherit",
  });


  if (!fs.existsSync(extractedRepoDir)) {
    // If repoName doesn't match folder (rare), fall back to first directory
    const entries = fs.readdirSync(extractRoot);
    const firstDir = entries.find((e) => fs.statSync(path.join(extractRoot, e)).isDirectory());
    if (!firstDir) throw new Error(`[workspace] extracted workspace missing repo folder`);
    return path.join(extractRoot, firstDir);
  }

  return extractedRepoDir;
}
