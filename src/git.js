// src/git.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";

export function repoNameFromUrl(url) {
  const clean = url.replace(/\/+$/, "");
  const last = clean.split("/").pop() || "repo";
  return last.replace(/\.git$/i, "");
}

function safe(s) {
  return String(s || "run").replace(/[^a-zA-Z0-9._-]+/g, "-");
}
export async function cloneRepo(url, ref = "main", destDir = null) {
  if (!url) throw new Error("TEST_REPO_URL missing");

  const runId = process.env.RUN_ID || process.env.JOB_ID || "run";
  const repoDir = destDir
    ? destDir
    : path.join(os.tmpdir(), `pw-repo-${safe(runId)}`, repoNameFromUrl(url));
  if (!fs.existsSync(repoDir)) {
    console.log(`Cloning ${url} (${ref}) → ${repoDir}`);
    await simpleGit().clone(url, repoDir);

    const repoGit = simpleGit(repoDir);
    await repoGit.checkout(ref);
    const hasLock = fs.existsSync(path.join(repoDir, "package-lock.json"));
    execSync(hasLock ? "npm ci" : "npm install", {
      stdio: "inherit",
      cwd: repoDir,
    });
  } else {
    try {
      const repoGit = simpleGit(repoDir);
      await repoGit.fetch();
      await repoGit.checkout(ref);
    } catch {}
    const nodeModules = path.join(repoDir, "node_modules");
    if (!fs.existsSync(nodeModules)) {
      const hasLock = fs.existsSync(path.join(repoDir, "package-lock.json"));
      execSync(hasLock ? "npm ci" : "npm install", {
        stdio: "inherit",
        cwd: repoDir,
      });
    }
  }

  process.chdir(repoDir);
  return repoDir;
}
