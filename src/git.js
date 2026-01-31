// src/git.js
import fs from "node:fs";
import simpleGit from "simple-git";

export async function cloneRepo(url, ref) {
  const repoDir = "/app/tests"; // or "/workspace/repo" — pick ONE stable path

  if (fs.existsSync(repoDir)) {
    console.log("🧹 Removing existing tests folder");
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(`📥 Cloning ${url} (${ref})`);
  const git = simpleGit();
  await git.clone(url, repoDir);
  const repoGit = simpleGit(repoDir);
  await repoGit.checkout(ref);

  // ✅ Ensure everything else runs from the same working dir in every task
  process.chdir(repoDir);
  console.log(`📁 Repo ready at ${repoDir}`);

  return repoDir;
}
