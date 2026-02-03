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

/**
 * Inyecta el token de GitLab en la URL si está presente en las variables de entorno
 */
function getAuthUrl(url) {
  const token = process.env.GITLAB_TOKEN;
  if (!token || !url.includes("gitlab.com")) return url;

  return url.replace("https://", `https://gitlab-ci-token:${token}@`);
}

export async function cloneRepo(url, ref = "main", destDir = null) {
  if (!url) throw new Error("TEST_REPO_URL missing");

  const authUrl = getAuthUrl(url);
  const runId = process.env.RUN_ID || "run";
  const repoDir = destDir
    ? destDir
    : path.join(os.tmpdir(), `pw-repo-${safe(runId)}`, repoNameFromUrl(url));

  if (!fs.existsSync(repoDir)) {
    console.log(`Cloning ${url} (${ref}) → ${repoDir}`);

    await simpleGit().clone(authUrl, repoDir, [
      "--single-branch",
      `--branch=${ref}`,
    ]);
  } else {
    try {
      const repoGit = simpleGit(repoDir);
      await repoGit.remote(["set-url", "origin", authUrl]);
      await repoGit.fetch();
      await repoGit.checkout(ref);
    } catch (err) {
      console.error("Error updating repo:", err.message);
    }
  }

  process.chdir(repoDir);
  const nodeModules = path.join(repoDir, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    const hasLock = fs.existsSync("package-lock.json");
    execSync(hasLock ? "npm ci" : "npm install", { stdio: "inherit" });
  }

  return repoDir;
}
