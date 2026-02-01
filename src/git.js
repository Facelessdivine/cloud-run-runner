// src/git.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";

function repoNameFromUrl(url) {
  const clean = url.replace(/\/+$/, "");
  const last = clean.split("/").pop() || "repo";
  return last.replace(/\.git$/i, "");
}

function safe(s) {
  return String(s || "run").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/**
 * Clone repo, checkout ref, install deps (once), chdir to repo root.
 * Returns repoDir.
 */
export async function cloneRepo(url, ref = "main") {
  if (!url) throw new Error("TEST_REPO_URL missing");

  const runId = process.env.RUN_ID || process.env.JOB_ID || "run";
  const repoDir = path.join(
    os.tmpdir(),
    `pw-repo-${safe(runId)}`,
    repoNameFromUrl(url),
  );

  // For local multi-shard loops: clone+install only once.
  if (!fs.existsSync(repoDir)) {
    console.log(`📥 Cloning ${url} (${ref}) → ${repoDir}`);
    await simpleGit().clone(url, repoDir);

    const repoGit = simpleGit(repoDir);
    await repoGit.checkout(ref);

    console.log("📦 Installing deps (npm ci if lockfile else npm install)...");
    const hasLock = fs.existsSync(path.join(repoDir, "package-lock.json"));
    execSync(hasLock ? "npm ci" : "npm install", {
      stdio: "inherit",
      cwd: repoDir,
    });
  } else {
    console.log(`⚡ Reusing cloned repo → ${repoDir}`);
    // Optional: ensure correct ref (cheap)
    try {
      const repoGit = simpleGit(repoDir);
      await repoGit.fetch();
      await repoGit.checkout(ref);
    } catch {
      // If local reuse gets messy, delete the folder manually and rerun.
    }

    // Ensure deps exist (in case repoDir was created but install failed)
    const nodeModules = path.join(repoDir, "node_modules");
    if (!fs.existsSync(nodeModules)) {
      console.log("📦 node_modules missing; installing deps...");
      const hasLock = fs.existsSync(path.join(repoDir, "package-lock.json"));
      execSync(hasLock ? "npm ci" : "npm install", {
        stdio: "inherit",
        cwd: repoDir,
      });
    }
  }

  process.chdir(repoDir);
  console.log(`📁 Repo ready at ${repoDir}`);
  return repoDir;
}
